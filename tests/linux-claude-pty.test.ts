import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { interruptClaude } from "../apps/windows/src/connectors/claude-interrupt.js";
import { writeLocalJson, type NativeSnapshot } from "../packages/pi-runtime/native-protocol.js";
import { initialState } from "../packages/cockpit-state/types.js";

test("Linux Claude PTY Stop is scoped, rejects stale/repeated requests, and preserves both CLI processes", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pilot-pty-test-"));
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => {
    for (const child of children) child.stdin?.write("q");
    for (let n = 0; n < 100 && children.some(child => child.exitCode === null); n++) await delay(25);
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });
  const until = async (check: () => Promise<boolean>) => { for (let n = 0; n < 150; n++) { if (await check()) return; await delay(20); } throw new Error("PTY fixture timeout"); };
  const owners: any[] = [];
  for (const name of ["a", "b"]) {
    const folder = join(root, name); await mkdir(folder);
    const code = `const fs=require('node:fs'); process.stdin.setRawMode(true); process.stdin.resume(); fs.writeFileSync(${JSON.stringify(join(folder, "ready"))},'1'); process.stdin.on('data', bytes=>{ for(const byte of bytes) { if(byte===113) process.exit(); fs.appendFileSync(${JSON.stringify(join(folder, "keys"))},String(byte)+'\\n'); } });`;
    const child = spawn("python3", [resolve("apps/linux/claude-pty.py"), folder, process.execPath, "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child); let errors = ""; child.stderr!.on("data", b => { errors += b; });
    await until(async () => { if (child.exitCode !== null) throw new Error(errors); try { await readFile(join(folder, "ready")); owners.push(JSON.parse(await readFile(join(folder, "owner.json"), "utf8"))); return true; } catch { return false; } });
  }
  const folder = join(root, "a"), file = join(folder, "snapshot.json"), key = "a".repeat(32);
  const state = initialState(); state.connected = true; state.session = { key, cwd: folder, tunnel: "claude" }; state.main = { status: "running" };
  const snapshot: NativeSnapshot = { version: 1, instance: randomUUID(), pid: process.pid, terminalPid: owners[0].pid,
    runId: 1, at: Date.now(), updatedAt: Date.now(), completions: [], state };
  writeLocalJson(file, { ...snapshot, at: Date.now() - 10000 }); await assert.rejects(interruptClaude(folder, file, snapshot));
  writeLocalJson(file, { ...snapshot, instance: randomUUID(), at: Date.now() }); await assert.rejects(interruptClaude(folder, file, snapshot));
  writeLocalJson(file, { ...snapshot, at: Date.now() }); await interruptClaude(folder, file, snapshot);
  await until(async () => { try { return await readFile(join(folder, "keys"), "utf8") === "27\n"; } catch { return false; } });
  await assert.rejects(interruptClaude(folder, file, snapshot));
  assert.equal(await readFile(join(folder, "keys"), "utf8"), "27\n");
  await assert.rejects(readFile(join(root, "b", "keys")), /ENOENT/);
  assert.ok(children.every(child => child.exitCode === null));
});
