import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { acquireBackendLock, BackendAlreadyRunning } from "../apps/windows/src/backend-lock.js";
import { sessionKey } from "../packages/pi-runtime/sessions.js";
import { savedEntries } from "./fixtures/saved-sessions.js";

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await delay(25); }
  assert.fail("Backend did not reach the expected state");
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pilot-backend-")), data = join(root, "data"), sessions = join(root, "agent/sessions");
  await mkdir(data); await mkdir(sessions, { recursive: true });
  const source = join(sessions, "saved.jsonl");
  await writeFile(source, savedEntries(root).map(e => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(data, "monitoring.json"), JSON.stringify({ version: 1, sessions: [{ key: sessionKey(source), monitored: true }] }));
  await writeFile(join(data, "glance-push.json"), JSON.stringify({ version: 1, subscriptions: [], retired: [], jobs: [] }));
  const token = "backend-test-control-12345678";
  await writeFile(join(data, "bridge-config.json"), JSON.stringify({ controlToken: token, notificationToken: "backend-test-notify-12345678" }));
  const socket = createServer(connection => connection.destroy()); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  const children: { child: ChildProcessWithoutNullStreams; output: string }[] = [];
  const start = (args: string[] = [], desktop = false) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(desktop ? "apps/windows/src/desktop-launch.ts" : "apps/windows/src/cli.ts"),
      "--cwd", root, "--host", "127.0.0.1", "--port", String(port), ...args], {
      cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, EVEN_PILOT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(root, "agent"),
        CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"),
        EVEN_PILOT_FCM_PROJECT_ID: "", EVEN_PILOT_TOKEN: "", EVEN_PILOT_NOTIFICATION_TOKEN: "", PI_CODING_AGENT_SESSION_DIR: "" },
    });
    const entry = { child, output: "" }; children.push(entry);
    child.stdout.on("data", b => { entry.output += b; }); child.stderr.on("data", b => { entry.output += b; });
    return entry;
  };
  const request = async (path = "/api/state", post = false) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: post ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: post ? "{}" : undefined,
      signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as any;
  };
  const files = async () => Promise.all(["monitoring.json", "glance-push.json"].map(name => readFile(join(data, name), "utf8")));
  t.after(async () => {
    await request("/api/shutdown", true).catch(() => {});
    for (const { child } of children) {
      for (let i = 0; child.exitCode === null && child.signalCode === null && i < 80; i++) await delay(25);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once("close", r)); }
    }
    if (socket.listening) await new Promise<void>(r => socket.close(() => r()));
    // A detached owner may still be releasing its cwd immediately after HTTP shutdown.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { root, data, socket, start, request, files };
}

test("backend data lock excludes concurrent owners and can be reacquired after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilot-lock-"));
  try {
    const release = await acquireBackendLock(root);
    try { await assert.rejects(acquireBackendLock(root), BackendAlreadyRunning); }
    finally { await release(); }
    await (await acquireBackendLock(root))();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop launcher exits while its detached monitor remains reachable without starting hidden Pi processes", async t => {
  const f = await fixture(t); await new Promise<void>(r => f.socket.close(() => r()));
  const launcher = f.start([], true);
  await until(() => launcher.child.exitCode !== null);
  assert.equal(launcher.child.exitCode, 0, launcher.output);
  await until(async () => { try { return Boolean((await f.request()).monitoring); } catch { return false; } });
  const state = await f.request();
  assert.equal(state.monitoring.watched, 1);
  const reopen = f.start([], true); await until(() => reopen.child.exitCode !== null);
  await delay(600);
  assert.equal((await f.request()).session.key, state.session.key);
  assert.equal((await f.request()).connected, false);
});

test("desktop backend automatically discovers ordinary Codex/App rollouts and journals their completion", async t => {
  const f = await fixture(t); await new Promise<void>(r => f.socket.close(() => r()));
  f.start([], true);
  await until(async () => { try { return Boolean((await f.request()).monitoring); } catch { return false; } });
  const directory = join(f.root, "codex", "sessions", "2026", "09", "30");
  await mkdir(directory, { recursive: true });
  for (const source of ["cli", "vscode"]) {
    const id = randomUUID();
    const rows = [
      { type: "session_meta", payload: { id, cwd: f.root, source } },
      { type: "event_msg", payload: { type: "task_started", turn_id: id } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: id } },
    ];
    await writeFile(join(directory, `rollout-${id}.jsonl`), rows.map(row => JSON.stringify({ timestamp: new Date().toISOString(), ...row })).join("\n") + "\n");
  }
  await until(async () => (await f.request("/api/completions")).events.length === 2);
  assert.equal((await f.request()).monitoring.watched, 3);
  const completions = (await f.request("/api/completions")).events;
  assert.equal(completions.every((e: any) => e.outcome === "completed"), true);
  assert.notEqual(completions[0].sessionKey, completions[1].sessionKey);
});

test("duplicate CLI startup leaves native sessions and push storage unchanged", async t => {
  const f = await fixture(t); await new Promise<void>(r => f.socket.close(() => r()));
  const owner = f.start();
  await until(async () => {
    if (owner.child.exitCode !== null) throw new Error(owner.output);
    try { return Boolean((await f.request()).monitoring); } catch { return false; }
  });
  const before = await f.files();
  const duplicate = f.start(); await until(() => duplicate.child.exitCode !== null);
  assert.equal(duplicate.child.exitCode, 0); assert.match(duplicate.output, /already running/);
  assert.deepEqual(await f.files(), before);
  assert.equal(owner.child.exitCode, null);
  assert.equal((await f.request()).monitoring.watched, 1);
});

test("an occupied HTTP port causes no session restoration or persisted push writes", async t => {
  const f = await fixture(t), before = await f.files();
  // Keep a non-HTTP listener open. The losing CLI must not even start Pi.
  const failed = f.start(); await until(() => failed.child.exitCode !== null);
  assert.equal(failed.child.exitCode, 0); assert.match(failed.output, /already running/);
  assert.deepEqual(await f.files(), before);
});

test("a crashed backend releases its kernel lock so monitoring can recover on the next launch", async t => {
  const f = await fixture(t); await new Promise<void>(r => f.socket.close(() => r()));
  const owner = f.start();
  await until(async () => { try { return Boolean((await f.request()).monitoring); } catch { return false; } });
  owner.child.kill("SIGKILL");
  await until(() => owner.child.exitCode !== null || owner.child.signalCode !== null);
  const replacement = f.start();
  await until(async () => {
    if (replacement.child.exitCode !== null) throw new Error(replacement.output);
    try { return Boolean((await f.request()).monitoring); } catch { return false; }
  });
  assert.equal((await f.request()).monitoring.watched, 1);
});
