import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { claudeProcessIdentity, hasClaudeInterruption, interruptClaude } from "../apps/windows/src/connectors/claude-interrupt.js";
import { writeLocalJson, processAlive, type NativeSnapshot } from "../packages/pi-runtime/native-protocol.js";
import { initialState } from "../packages/cockpit-state/types.js";
import { stdioRpc } from "../packages/connectors/rpc.js";
import { readLocalJson } from "../packages/pi-runtime/native-protocol.js";
import { once } from "node:events";

const run = promisify(execFile);
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Fixture timeout"); await delay(30); }
}
test("Windows Stop injects one Escape into only the bound console and leaves both native processes alive", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pilot-console-"));
  const a = join(root, "a"), b = join(root, "b"); await mkdir(a); await mkdir(b);
  const compiler = join(process.env.WINDIR!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const receiver = join(root, "Receiver.exe");
  await run(compiler, ["/nologo", "/target:exe", "/out:" + receiver, resolve("tests/desktop/ConsoleReceiver.cs")], { windowsHide: true });
  const owners: { pid: number; started: string }[] = [];
  t.after(async () => {
    await writeFile(join(a, "close"), ""); await writeFile(join(b, "close"), "");
    await until(() => owners.every(owner => !processAlive(owner.pid)));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const folder of [a, b]) {
    const launcher = spawn(receiver, ["launch", folder], { windowsHide: true, stdio: "ignore" });
    const [code] = await once(launcher, "exit");
    assert.equal(code, 0, "Hidden fixture launcher exits normally");
    await until(async () => {
      const error = await readFile(join(folder, "ready.error"), "utf8").catch(() => "");
      if (error) throw new Error(error);
      try { await readFile(join(folder, "ready.json")); return true; } catch { return false; }
    });
    const owner = JSON.parse(await readFile(join(folder, "ready.json"), "utf8"));
    assert.equal(owner.visible, false, "Fixture must not show a console window");
    owners.push(owner);
  }
  const owner = owners[0], key = "a".repeat(32), instance = randomUUID();
  assert.equal(await claudeProcessIdentity(owner.pid), owner.started);
  writeLocalJson(join(a, "owner.json"), owner);
  const snapshot: NativeSnapshot = { version: 1, instance, pid: process.pid, terminalPid: owner.pid,
    runId: 1, at: Date.now(), updatedAt: Date.now(), completions: [], state: { ...initialState(), connected: true,
      session: { key, tunnel: "claude", cwd: a }, main: { status: "running" } } };
  const path = join(a, "snapshot.json"); writeLocalJson(path, snapshot);
  await interruptClaude(a, path, snapshot);
  await until(async () => { try { return (await readFile(join(a, "keys.txt"), "utf8")) === "27\n"; } catch { return false; } });
  assert.equal(owners.every(owner => processAlive(owner.pid)), true);
  await assert.rejects(readFile(join(b, "keys.txt")), /ENOENT/);
  // A resumed session, changed process identity, and expired state must never get a key.
  writeLocalJson(path, { ...snapshot, instance: randomUUID(), at: Date.now() });
  await assert.rejects(interruptClaude(a, path, snapshot));
  writeLocalJson(path, { ...snapshot, at: Date.now() }); writeLocalJson(join(a, "owner.json"), { ...owner, started: "638000000000000000" });
  await assert.rejects(interruptClaude(a, path, snapshot));
  writeLocalJson(join(a, "owner.json"), owner); writeLocalJson(path, { ...snapshot, at: Date.now() - 10000 });
  await assert.rejects(interruptClaude(a, path, snapshot));
  assert.equal(await readFile(join(a, "keys.txt"), "utf8"), "27\n");

  // Exercise the actual channel process and mailbox against the hidden console.
  const configRoot = join(root, "claude"), projects = join(configRoot, "projects", "fixture"), id = randomUUID();
  await mkdir(projects, { recursive: true });
  const transcript = join(projects, id + ".jsonl");
  const entry = (text: string) => JSON.stringify({ type: "user", sessionId: id, cwd: a, uuid: randomUUID(),
    timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
  const history = entry("Fixture task"); await writeFile(transcript, history + "\n");
  const { rpc, child } = stdioRpc({ command: process.execPath, args: ["--import", "tsx"] },
    [resolve("apps/windows/src/connectors/claude-channel.ts"), root, a, a, id], { ...process.env, CLAUDE_CONFIG_DIR: configRoot });
  try {
    await rpc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
    rpc.notify("notifications/initialized");
    const channelPath = join(root, "native", child.pid + ".json");
    await until(() => { try { return readLocalJson(channelPath).terminalPid === owner.pid; } catch { return false; } });
    const endpoint = readLocalJson(join(a, "endpoint.json"));
    const post = (hook_event_name: string, extra: object = {}) => fetch("http://127.0.0.1:" + endpoint.port + "/event", {
      method: "POST", headers: { Authorization: "Bearer " + endpoint.token },
      body: JSON.stringify({ session_id: id, hook_event_name, transcript_path: transcript, ...extra }),
    });
    assert.equal((await post("UserPromptSubmit", { prompt: "Fixture task" })).status, 204);
    await until(() => readLocalJson(channelPath).state.main.status === "running");
    const current = readLocalJson(channelPath);
    assert.equal(current.state.capabilities.interrupt, true);
    const command = async (commandId: string, type: string, runId = current.runId) => {
      writeLocalJson(join(root, "native", current.instance + ".command.json"), { id: commandId, type, instance: current.instance,
        key: current.state.session.key, text: "Follow-up", runId, expiresAt: Date.now() + 5000 });
      const responsePath = join(root, "native", current.instance + ".reply.json");
      try { await until(() => { try { return readLocalJson(responsePath).id === commandId; } catch { return false; } }); }
      catch {
        let reply = "missing", status = "missing";
        try { reply = readLocalJson(responsePath).id; } catch {}
        try { status = readLocalJson(channelPath).state.main.status; } catch {}
        throw new Error(`Fixture command ${commandId} timed out; exit=${child.exitCode}, signal=${child.signalCode}, status=${status}, reply=${reply}`);
      }
      return readLocalJson(responsePath);
    };
    assert.match((await command("old-run", "interrupt", current.runId - 1)).error, /changed/);
    assert.equal((await command("stop", "interrupt")).error, undefined);
    await until(async () => (await readFile(join(a, "keys.txt"), "utf8")) === "27\n27\n");
    assert.equal(readLocalJson(channelPath).state.main.status, "running", "key delivery alone cannot fabricate completion");
    assert.match((await command("duplicate", "interrupt")).error, /already requested/);
    assert.equal(await readFile(join(a, "keys.txt"), "utf8"), "27\n27\n");
    await writeFile(transcript, history + "\n" + entry("[Request interrupted by user]") + "\n");
    await until(() => readLocalJson(channelPath).state.main.status === "idle");
    const settled = readLocalJson(channelPath);
    assert.equal(settled.completions.length, 1); assert.equal(settled.completions[0].outcome, "interrupted");
    assert.equal(settled.state.connected, true); assert.equal(settled.instance, current.instance);
    assert.equal((await command("follow-up", "prompt")).error, undefined);
    assert.equal(owners.every(owner => processAlive(owner.pid)), true);
    await assert.rejects(readFile(join(b, "keys.txt")), /ENOENT/);
  } finally {
    const exited = once(child, "exit"); rpc.close(); if (child.exitCode === null) await exited;
  }
});

test("Claude cancellation requires a new native interruption marker in the same turn", () => {
  const id = randomUUID(), at = Date.now();
  const row = (text: string, extra: object = {}) => JSON.stringify({ type: "user", sessionId: id, timestamp: new Date(at).toISOString(),
    message: { role: "user", content: [{ type: "text", text }] }, ...extra });
  const marker = row("[Request interrupted by user]");
  assert.equal(hasClaudeInterruption(marker, id, at), true);
  assert.equal(hasClaudeInterruption(row("[Request interrupted by user for tool use]"), id, at), true);
  assert.equal(hasClaudeInterruption(marker, id, at + 1), false);
  assert.equal(hasClaudeInterruption(marker, "another", at), false);
  assert.equal(hasClaudeInterruption(row("[Request interrupted by user]", { isSidechain: true }), id, at), false);
  assert.equal(hasClaudeInterruption(marker + "\n" + row("Next prompt"), id, at), false);
  assert.equal(hasClaudeInterruption(row("Please stop"), id, at), false);
});
