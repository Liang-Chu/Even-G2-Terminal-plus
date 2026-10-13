import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { NativeHost } from "../packages/pi-runtime/native-host.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { connectorKey } from "../packages/connectors/identity.js";
import { listNativeQuestionRequests, waitForNativeClaudeQuestion } from "../apps/windows/src/claude-native-question.mjs";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Native Claude integration fixture timed out"); await delay(15); }
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "terminal-plus-native-integration-")), data = join(root, "data"),
    logs = join(root, "projects"), queue = join(data, "claude-events");
  await mkdir(data, { mode: 0o700 }); await mkdir(logs); await mkdir(queue);
  const owner = { pid: 91001, started: "111" }, hookPid = 91002;
  const identify = async (pid: number) => pid === owner.pid ? owner.started : pid === hookPid ? "333" : pid === process.pid ? "222" : undefined;
  const host = new NativeHost({ cwd: root, directory: join(data, "native"), preferencesPath: join(data, "watch.json"),
    sessions: { root: join(root, "pi") }, launch: async () => assert.fail("Ordinary question answers must never launch another CLI"),
    claudeObservation: { directory: queue, root: logs, alive: async () => true, canAnswer: () => true, questionIdentity: identify } });
  const journal = new NotificationJournal(host.store);
  const bridge = createBridgeServer(host, journal, { host, token: "c".repeat(32), notificationToken: "n".repeat(32) });
  await new Promise<void>(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
  const address = bridge.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const helpers: Promise<any>[] = [];
  t.after(async () => { await host.stop(); await Promise.allSettled(helpers); await bridge.close(); journal.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await host.start();
  const post = (path: string, body: unknown, token = "c".repeat(32)) => fetch(base + path, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const id = randomUUID(), key = connectorKey("claude", id), path = join(logs, id + ".jsonl");
  await writeFile(path, JSON.stringify({ type: "user", sessionId: id, cwd: root,
    timestamp: new Date().toISOString(), message: { role: "user", content: "Integration fixture" } }) + "\n");
  async function emit(name: string, extra: Record<string, unknown> = {}) {
    const eventId = randomUUID(), at = Date.now();
    const event = { version: 1, eventId, at, hook_event_name: name, session_id: id, owner,
      transcript_path: path, cwd: root, stopTrusted: true, ...extra };
    await writeFile(join(queue, `${at}-${eventId}.json`), JSON.stringify(event)); return event;
  }
  await emit("UserPromptSubmit", { prompt: "Synthetic new turn" });
  await until(() => host.store.state.monitoring?.sessions.some(row => row.key === key) === true);
  await host.selectWatchedSession(key);
  async function ask(toolId: string) {
    const event = await emit("PreToolUse", { tool_use_id: toolId, tool_name: "AskUserQuestion" });
    const input = { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: toolId,
      tool_input: { questions: [{ question: "PRIVATE_FIXTURE_QUESTION", multiSelect: true,
        options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }] }] } };
    const result = waitForNativeClaudeQuestion(data, input, event, owner, { identify, hookPid, timeout: 8000, pollMs: 15 });
    helpers.push(result);
    await until(() => !!host.getRuntime(key).store.state.interactions?.length);
    return { result, request: host.getRuntime(key).store.state.interactions![0] };
  }
  async function permission() {
    // The official PermissionRequest input has no tool_use_id.
    const event = await emit("PermissionRequest", { tool_name: "Bash" });
    const input = { hook_event_name: "PermissionRequest", tool_name: "Bash",
      tool_input: { command: "PRIVATE_ACTION_FIXTURE_ONLY", description: "Synthetic preview; never executed" } };
    const result = waitForNativeClaudeQuestion(data, input, event, owner, { identify, hookPid, timeout: 8000, pollMs: 15 });
    helpers.push(result);
    await until(() => !!host.getRuntime(key).store.state.interactions?.length);
    return { result, request: host.getRuntime(key).store.state.interactions![0] };
  }
  return { root, data, host, journal, post, emit, ask, permission, key };
}

test("ordinary native Claude question travels through the authenticated phone API with one Needs input notice", async t => {
  const f = await fixture(t), { result, request } = await f.ask("toolu_http");
  const state = f.host.getRuntime(f.key).store.state;
  assert.deepEqual(state.capabilities, { prompt: false, interrupt: false });
  assert.equal(state.main.status, "waiting");
  assert.equal(f.journal.list().filter(event => event.kind === "attention").length, 1);
  assert.equal((await f.post("/api/interaction/respond", { sessionKey: f.key, requestId: request.id, answers: { q0: "1,3" } }, "n".repeat(32))).status, 403);
  assert.equal((await f.post("/api/interaction/respond", { sessionKey: "0".repeat(32), requestId: request.id, answers: { q0: "1,3" } })).status, 409);
  const response = await f.post("/api/interaction/respond", { sessionKey: f.key, requestId: request.id, answers: { q0: "1,3" } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: "submitted" });
  const output = await result;
  assert.ok(output && "updatedInput" in output.hookSpecificOutput);
  assert.equal(output.hookSpecificOutput.updatedInput.answers.PRIVATE_FIXTURE_QUESTION, "Alpha, Gamma");
  assert.equal((await f.post("/api/interaction/respond", { sessionKey: f.key, requestId: request.id, answers: { q0: "1,3" } })).status, 409);
  assert.equal((await f.post("/api/prompt", { sessionKey: f.key, text: "Do not start another model turn" })).status, 409);
  assert.equal(f.host.getRuntime(f.key).store.state.main.status, "running");
  assert.equal(f.journal.list().filter(event => event.kind === "attention").length, 1);
  assert.equal(f.journal.list().filter(event => event.kind === "attention-resolved").length, 1);
  assert.equal(f.journal.list().filter(event => !event.kind || event.kind === "completion").length, 0);
  const saved = await readFile(join(f.data, "claude-monitor-state.json"), "utf8");
  assert.doesNotMatch(saved, /PRIVATE_FIXTURE_QUESTION|Alpha, Gamma/);
  assert.doesNotMatch(JSON.stringify(f.journal.list()), /PRIVATE_FIXTURE_QUESTION|Alpha, Gamma/);
  assert.equal(listNativeQuestionRequests(f.data).length, 0);
  assert.deepEqual((await readdir(join(f.data, "claude-questions"))).filter(name => name !== "availability.json"), []);
  await f.emit("PostToolUse", { tool_use_id: "toolu_http" }); await f.emit("Stop", { background_tasks: [] });
  await until(() => f.journal.list().some(event => !event.kind || event.kind === "completion"));
  assert.equal(f.journal.list().filter(event => !event.kind || event.kind === "completion").length, 1);
});

test("Unwatch retires a native Claude question and releases its hook without stopping the native run", async t => {
  const f = await fixture(t), { result, request } = await f.ask("toolu_unwatch");
  await f.host.setMonitored(f.key, false);
  assert.equal(await result, undefined);
  await until(() => !f.host.getRuntime(f.key).store.state.interactions?.length);
  const state = f.host.getRuntime(f.key).store.state;
  assert.equal(state.connected, true); assert.equal(state.main.status, "waiting"); assert.equal(state.attention?.length, 1);
  assert.equal((await f.post("/api/interaction/respond", { sessionKey: f.key, requestId: request.id, answers: { q0: "1,3" } })).status, 409);
  assert.equal(f.journal.list().filter(event => !event.kind || event.kind === "completion").length, 0);
});

test("native Claude permission uses the authenticated API and an explicit once-only decision", async t => {
  for (const [answer, expected] of [["允许一次。", "allow"], ["Deny", "deny"]] as const) {
    const f = await fixture(t), { result, request } = await f.permission();
    assert.equal(request.kind, "approval");
    assert.deepEqual(JSON.parse(request.detail!), { tool: "Bash", input: {
      command: "PRIVATE_ACTION_FIXTURE_ONLY", description: "Synthetic preview; never executed" } });
    assert.equal(f.journal.list().filter(event => event.kind === "attention").length, 1);
    const body = { sessionKey: f.key, requestId: request.id, answers: { decision: answer } };
    assert.equal((await f.post("/api/interaction/respond", body, "n".repeat(32))).status, 403);
    assert.equal((await f.post("/api/interaction/respond", { ...body, answers: { decision: "always allow" } })).status, 400);
    assert.equal(f.host.getRuntime(f.key).store.state.interactions?.length, 1, "Invalid approval remains correctable");
    assert.equal((await f.post("/api/interaction/respond", body)).status, 200);
    assert.deepEqual(await result, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: expected } } });
    assert.equal((await f.post("/api/interaction/respond", body)).status, 409);
    assert.equal(f.host.getRuntime(f.key).store.state.main.status, "running");
    assert.equal(f.journal.list().filter(event => event.kind === "attention-resolved").length, 1);
    assert.equal(f.journal.list().filter(event => !event.kind || event.kind === "completion").length, 0);
    const saved = await readFile(join(f.data, "claude-monitor-state.json"), "utf8");
    assert.doesNotMatch(saved, /PRIVATE_ACTION_FIXTURE_ONLY|Synthetic preview/);
    assert.doesNotMatch(JSON.stringify(f.journal.list()), /PRIVATE_ACTION_FIXTURE_ONLY|Synthetic preview/);
    assert.deepEqual((await readdir(join(f.data, "claude-questions"))).filter(name => name !== "availability.json"), []);
  }
});
