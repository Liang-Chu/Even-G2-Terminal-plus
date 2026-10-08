import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalJson, type NativeSnapshot } from "../../../../packages/pi-runtime/native-protocol.js";

const helper = fileURLToPath(new URL("../../desktop/Terminal-plus.TerminalInterrupt.exe", import.meta.url));
export const claudeInterruptAvailable = () => process.platform === "linux" || (process.platform === "win32" && existsSync(helper));
export const validClaudeOwner = (owner: any) => process.platform === "linux"
  ? /^\d+$/.test(owner.started || "") && typeof owner.socket === "string" && /^[a-f0-9]{64}$/.test(owner.token || "")
  : /^\d{15,20}$/.test(owner.started || "");
const invoke = (args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(helper, args, { windowsHide: true, timeout: 2500, maxBuffer: 1024 }, (error, stdout) => {
    if (error) reject(new Error("Claude stop was not confirmed. Check its terminal before trying again."));
    else resolve(stdout.trim());
  });
});
export async function claudeProcessIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19];
  if (!claudeInterruptAvailable()) return;
  const identity = await invoke(["identity", String(pid)]);
  if (!/^\d{15,20}$/.test(identity)) throw new Error("Invalid Claude process identity");
  return identity;
}
export async function interruptClaude(runDirectory: string, snapshotPath: string, snapshot: NativeSnapshot) {
  const owner = readLocalJson(join(runDirectory, "owner.json"));
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !validClaudeOwner(owner)
    || snapshot.terminalPid !== owner.pid) throw new Error("Reopen this Claude session through Terminal+ to enable Stop.");
  if (!snapshot.state.connected || !["running", "waiting"].includes(snapshot.state.main.status)) throw new Error("Claude is not running");
  if (process.platform === "linux") {
    if (await claudeProcessIdentity(owner.pid) !== owner.started) throw new Error("Claude's terminal changed");
    await new Promise<void>((done, fail) => {
      const socket = createConnection(owner.socket);
      let output = "";
      const reject = () => { socket.destroy(); fail(new Error("Claude Stop was not confirmed. Check its terminal before trying again.")); };
      socket.setTimeout(2500, reject); socket.once("error", reject);
      socket.once("connect", () => socket.write(JSON.stringify({ token: owner.token, deadline: Date.now() + 2000,
        snapshot: snapshotPath, instance: snapshot.instance, key: snapshot.state.session.key, runId: snapshot.runId }) + "\n"));
      socket.on("data", data => {
        output += data.toString();
        if (output.length > 1024) { reject(); return; }
        if (!output.includes("\n")) return;
        try { if (JSON.parse(output).ok !== true) { reject(); return; } } catch { reject(); return; }
        socket.destroy(); done();
      });
      socket.once("end", () => { if (!output.includes("\n")) reject(); });
    });
    return;
  }
  await invoke(["interrupt", String(owner.pid), owner.started, String(Date.now() + 2000), snapshotPath,
    snapshot.instance, snapshot.state.session.key!, String(snapshot.runId)]);
}

/** Claude does not fire Stop on user interruption. Accept only a new native
 * interruption record, after this explicit stop request and before another prompt. */
export function hasClaudeInterruption(text: string, sessionId: string, since: number): boolean {
  let interrupted = false;
  for (const line of text.split("\n")) {
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    if (row.sessionId !== sessionId || row.isSidechain || row.type !== "user" || row.message?.role !== "user"
      || !Number.isFinite(Date.parse(row.timestamp)) || Date.parse(row.timestamp) < since) continue;
    const content = row.message.content;
    const body = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") : "";
    if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(body.trim())) interrupted = true;
    else if (body && !row.isMeta && !row.toolUseResult) interrupted = false;
  }
  return interrupted;
}
