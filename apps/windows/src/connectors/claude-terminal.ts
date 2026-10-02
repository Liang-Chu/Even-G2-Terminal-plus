import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgent } from "../../../../packages/connectors/command.js";
import { writeLocalJson } from "../../../../packages/pi-runtime/native-protocol.js";
import { claudeProcessIdentity } from "./claude-interrupt.js";
import { executable, shellQuote } from "../../../linux/src/platform.js";

const psLiteral = (value: string) => "'" + value.replace(/'/g, "''") + "'";
export async function claudeTerminal(options: { data: string; cwd: string; id?: string; resume?: boolean }) {
  const id = options.id || randomUUID(), runDirectory = join(options.data, "connector-runtime", randomUUID());
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const loader = new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const channel = fileURLToPath(new URL("./claude-channel.ts", import.meta.url));
  const hook = fileURLToPath(new URL("./claude-hook.ts", import.meta.url));
  const hookArgs = [process.execPath, "--import", loader, hook, runDirectory];
  const hookScript = "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::In.ReadToEnd() | & " + hookArgs.map(psLiteral).join(" ");
  const hookCommand = process.platform === "linux" ? hookArgs.map(shellQuote).join(" ")
    : "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + Buffer.from(hookScript, "utf16le").toString("base64");
  const hookNames = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "SessionEnd"];
  const settings = join(runDirectory, "settings.json"), mcp = join(runDirectory, "mcp.json");
  writeLocalJson(settings, { hooks: Object.fromEntries(hookNames.map(name => [name, [{ hooks: [{ type: "command", command: hookCommand, timeout: 2 }] }]])) });
  writeLocalJson(mcp, { mcpServers: { "even-pilot": { command: process.execPath,
    args: ["--import", loader, channel, options.data, runDirectory, options.cwd, id] } } });
  const command = resolveAgent("claude");
  const args = [...command.args, ...(options.resume ? ["--resume", id] : ["--session-id", id]),
    "--settings", settings, "--mcp-config", mcp, "--dangerously-load-development-channels", "server:even-pilot"];
  // The flag enables only this custom channel, never bypasses tool permissions.
  const python = process.platform === "linux" ? await executable("python3") : undefined;
  if (process.platform === "linux" && !python) throw new Error("Claude's Linux terminal connector requires Python 3 (standard library only).");
  const env = { ...process.env, EVEN_PILOT_CLAUDE_CONNECTOR: "1" };
  const child = python ? spawn(python, [fileURLToPath(new URL("../../../linux/claude-pty.py", import.meta.url)), runDirectory, command.command, ...args],
    { cwd: options.cwd, env, stdio: "inherit", shell: false })
    : spawn(command.command, args, { cwd: options.cwd, env, stdio: "inherit", shell: false, windowsHide: false });
  const exited = new Promise<void>((done, fail) => { child.once("error", fail); child.once("exit", () => done()); });
  void exited.catch(() => {});
  if (child.pid && !python) {
    writeLocalJson(join(runDirectory, "owner.json"), { pid: child.pid });
    // This optional capability must never prevent the user's CLI from running.
    const started = await claudeProcessIdentity(child.pid).catch(() => undefined);
    writeLocalJson(join(runDirectory, "owner.json"), { pid: child.pid, started });
  }
  await exited;
}
