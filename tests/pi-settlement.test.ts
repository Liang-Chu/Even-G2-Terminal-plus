import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import monitor from "../apps/windows/src/pi-extension.js";
import { readLocalJson, type NativeSnapshot } from "../packages/pi-runtime/native-protocol.js";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "terminal-plus-pi-settle-"));
  const prior = process.env.EVEN_PILOT_DATA_DIR;
  process.env.EVEN_PILOT_DATA_DIR = root;
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const handlers = new Map<string, any>();
  let idle = true, queued = false;
  const ctx = { mode: "tui", cwd: root, isIdle: () => idle, hasPendingMessages: () => queued, abort() {},
    sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "fixture",
      getSessionName: () => "Work", getBranch: () => [] } };
  monitor({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: () => assert.fail("Monitor must not start work") });
  const emit = (type: string, fields = {}) => handlers.get(type)({ type, ...fields }, ctx);
  const read = () => readLocalJson(join(root, "native", `${process.pid}.json`)) as NativeSnapshot;
  emit("session_start");
  t.after(() => {
    emit("session_shutdown"); t.mock.timers.reset();
    if (prior === undefined) delete process.env.EVEN_PILOT_DATA_DIR; else process.env.EVEN_PILOT_DATA_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const tick = (ms = 500) => t.mock.timers.tick(ms);
  const start = () => { idle = false; emit("agent_start"); tick(250); };
  const settle = (fields = {}) => { idle = true; emit("agent_settled", fields); };
  return { emit, read, tick, start, settle, idle: (value: boolean) => { idle = value; }, queued: (value: boolean) => { queued = value; } };
}

test("Pi settled hooks can continue without a false idle frame or completion", t => {
  const f = fixture(t); f.start(); const first = f.read().runId;
  f.settle(); f.tick(250);
  assert.equal(f.read().state.main.status, "running");
  assert.equal(f.read().completions.length, 0);
  f.start(); f.tick(1000);
  assert.ok(f.read().runId > first);
  assert.equal(f.read().state.main.status, "running");
  assert.equal(f.read().completions.length, 0);
  f.settle(); f.tick();
  assert.equal(f.read().state.main.status, "idle");
  assert.deepEqual(f.read().completions.map(c => c.id), [f.read().runId]);
  f.emit("agent_settled"); f.tick(2500);
  assert.equal(f.read().completions.length, 1, "Duplicate final callbacks cannot replay completion");
});

test("Pi active tools and pending messages prevent settlement until work is really idle", t => {
  const f = fixture(t); f.start();
  f.emit("tool_execution_start", { toolName: "bash", toolCallId: "shell" });
  f.settle(); f.tick(2000);
  assert.equal(f.read().state.main.status, "running");
  assert.ok(f.read().state.tools.active.shell);
  assert.equal(f.read().completions.length, 0);
  f.queued(true);
  f.emit("tool_execution_end", { toolCallId: "shell", isError: false }); f.tick(1000);
  assert.equal(f.read().completions.length, 0);
  f.queued(false); f.idle(false); f.tick(1000);
  assert.equal(f.read().completions.length, 0, "Post-run work still owned by Pi cannot complete");
  f.idle(true); f.tick(250);
  assert.equal(f.read().completions.length, 1);
  assert.equal(f.read().state.main.status, "idle");
});

test("Pi retry and shutdown never turn a pending settle into success", t => {
  const f = fixture(t); f.start(); f.settle();
  f.emit("auto_retry_start"); f.tick(2000);
  assert.equal(f.read().state.main.status, "running");
  assert.equal(f.read().completions.length, 0);
  f.settle(); f.emit("session_shutdown"); f.tick(2000);
  assert.equal(f.read().state.connected, false);
  assert.equal(f.read().completions.length, 0);
});

test("Pi confirms genuine final completion and preserves an aborted outcome", t => {
  const f = fixture(t); f.start(); f.settle({ aborted: true }); f.tick();
  assert.equal(f.read().state.main.status, "idle");
  assert.equal(f.read().completions.length, 1);
  assert.equal(f.read().completions[0].outcome, "interrupted");
});
