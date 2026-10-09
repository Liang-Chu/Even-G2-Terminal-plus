import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CodexInputTracker, codexInputRecord } from "../packages/connectors/codex-input.js";
import { CodexObserver, type CodexObservation } from "../packages/connectors/codex-observer.js";
import { sessionAgentCount } from "../packages/cockpit-state/selectors.js";

const at = Date.now() - 1000;
const row = (payload: unknown, type = "response_item", time = at) => ({ timestamp: new Date(time).toISOString(), type, payload });
const call = (id = "call_question", name = "request_user_input_async", count = 2, time = at) => row({ type: "function_call", call_id: id, name,
  arguments: JSON.stringify({ questions: Array.from({ length: count }, (_, index) => ({ id: `question_${index}`, question: "PRIVATE QUESTION", options: [] })) }) }, undefined, time);
const output = (id: string, value: unknown) => row({ type: "function_call_output", call_id: id, output: JSON.stringify(value) });
const nativeAsync = (id: string, titles: unknown[] = ["PRIVATE NATIVE TITLE", "PRIVATE SECOND TITLE"]) => row({ type: "function_call", call_id: id,
  name: "request_user_input_async", arguments: JSON.stringify({ questions: titles.map(title => ({ title, options: ["PRIVATE OPTION"] })) }) });
const replyText = (id: string, indices: number[], name = "request_user_input_async") => `<send_user_message_question_reply>\n${JSON.stringify(indices.map(index => ({
  questionItemId: JSON.stringify([name, id, index]), question: "PRIVATE QUESTION", answer: "PRIVATE ANSWER",
})))}\n</send_user_message_question_reply>`;
const reply = (id: string, indices: number[], name?: string, event = false) => event
  ? row({ type: "item_completed", item: { type: "UserMessage", id: randomUUID(), content: [{ type: "text", text: replyText(id, indices, name) }] } }, "event_msg")
  : row({ type: "message", role: "user", content: [{ type: "input_text", text: replyText(id, indices, name) }] });

test("async accepted output stays pending; exact partial replies and duplicate copies resolve each index once", () => {
  const tracker = new CodexInputTracker();
  assert.equal(tracker.consume(codexInputRecord(call(), "turn_a")), true);
  assert.equal(tracker.consume(codexInputRecord(call(undefined, "functions.request_user_input_async", 2, at + 100), "turn_a")), false);
  assert.equal(tracker.consume(codexInputRecord(output("call_question", { accepted: true }))), false);
  assert.equal(tracker.pending().length, 1); assert.equal(tracker.pending()[0].createdAt, at);
  assert.equal(tracker.consume(codexInputRecord(reply("call_question", [1]))), true);
  assert.equal(tracker.consume(codexInputRecord(reply("call_question", [1], undefined, true))), false);
  assert.deepEqual(tracker.snapshot().requests[0].answered, [1]);
  assert.equal(tracker.consume(codexInputRecord(reply("call_question", [0]))), true);
  assert.deepEqual(tracker.pending(), []);
  assert.equal(tracker.consume(codexInputRecord(call())), false, "replayed request cannot reopen a completed call");
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /PRIVATE|question_0|question_1/, "only hashed question IDs and lifecycle metadata persist");
});

test("current Desktop async title-only records track exact questions without storing titles or accepting title-only synchronous calls", () => {
  const tracker = new CodexInputTracker();
  assert.equal(tracker.consume(codexInputRecord(nativeAsync("native_title"), "turn_native")), true);
  assert.equal(tracker.consume(codexInputRecord(output("native_title", { accepted: true }))), false);
  assert.equal(tracker.pending().length, 1); assert.equal(tracker.snapshot().requests[0].count, 2);
  tracker.consume(codexInputRecord(reply("native_title", [1], undefined, true)));
  assert.deepEqual(tracker.snapshot().requests[0].answered, [1]);
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /PRIVATE|"title"\s*:|"options"\s*:/);
  tracker.consume(codexInputRecord(reply("native_title", [0]))); assert.deepEqual(tracker.pending(), []);
  const sync = row({ type: "function_call", call_id: "sync_title", name: "request_user_input",
    arguments: JSON.stringify({ questions: [{ title: "PRIVATE NATIVE TITLE" }] }) });
  assert.equal(codexInputRecord(sync), undefined);
  for (const title of ["", "   ", 1, null, "x".repeat(64_001)]) assert.equal(codexInputRecord(nativeAsync("malformed", [title])), undefined);
});

test("unknown, wrong-tool, out-of-range and quoted reply envelopes cannot answer a known call", () => {
  const tracker = new CodexInputTracker(); tracker.consume(codexInputRecord(call()));
  for (const value of [reply("unknown", [0]), reply("call_question", [0], "request_user_input"), reply("call_question", [-1, 2, 999]),
    row({ type: "message", role: "assistant", content: [{ type: "output_text", text: replyText("call_question", [0, 1]) }] }),
    row({ type: "message", role: "user", content: [{ type: "input_text", text: "Quoted example: " + replyText("call_question", [0, 1]) }] }),
    output("unknown", { error: "timeout" })]) assert.equal(tracker.consume(codexInputRecord(value)), false);
  assert.equal(tracker.pending().length, 1); assert.deepEqual(tracker.snapshot().requests[0].answered, []);
});

test("sync tool answers match the original question IDs; async success-shaped output is not a reply", () => {
  const tracker = new CodexInputTracker(); tracker.consume(codexInputRecord(call("sync", "request_user_input")));
  tracker.consume(codexInputRecord(output("sync", { answers: { unrelated: { answers: ["yes"] } } })));
  assert.deepEqual(tracker.snapshot().requests[0].answered, []);
  tracker.consume(codexInputRecord(output("sync", { answers: { question_1: { answers: ["PRIVATE ANSWER"] } } })));
  assert.deepEqual(tracker.snapshot().requests[0].answered, [1]);
  tracker.consume(codexInputRecord(output("sync", { answers: { question_0: { answers: ["yes"] } } })));
  assert.equal(tracker.pending().length, 0);
  tracker.consume(codexInputRecord(call("async", "request_user_input_async", 1)));
  assert.equal(tracker.consume(codexInputRecord(output("async", { answers: { question_0: { answers: ["yes"] } } }))), false);
  assert.equal(tracker.pending().length, 1);
});

test("explicit rejection and structured tool errors clear only their matching call without inventing lifecycle", () => {
  for (const failure of [{ accepted: false }, { error: "timeout" }, { error: { code: "timeout" } }, { status: "timeout" }, { isError: true }]) {
    const tracker = new CodexInputTracker(); tracker.consume(codexInputRecord(call("first", undefined, 1)));
    tracker.consume(codexInputRecord(call("other", undefined, 1)));
    assert.equal(tracker.consume(codexInputRecord(output("first", failure))), true);
    assert.deepEqual(tracker.pending().map(request => request.id), ["other"]);
  }
});

test("bounded Unicode and space-containing sync question IDs resolve exactly without persisting their text", () => {
  const tracker = new CodexInputTracker(), id = "选择 格式";
  tracker.consume(codexInputRecord(row({ type: "function_call", call_id: "unicode", name: "request_user_input",
    arguments: JSON.stringify({ questions: [{ id, question: "PRIVATE QUESTION" }] }) })));
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /选择|格式|PRIVATE/);
  assert.equal(tracker.consume(codexInputRecord(output("unicode", { answers: { [id]: { answers: ["yes"] } } }))), true);
  assert.deepEqual(tracker.pending(), []);
});

test("restored pending metadata retains original time and indices, with per-request baseline suppression", () => {
  const tracker = new CodexInputTracker(); tracker.consume(codexInputRecord(call(), "turn_a")); tracker.consume(codexInputRecord(reply("call_question", [0])));
  const restarted = new CodexInputTracker(tracker.snapshot());
  assert.deepEqual(restarted.pending(), [{ id: "call_question", kind: "question", createdAt: at, baseline: true }]);
  restarted.consume(codexInputRecord(call("new_live", undefined, 1, at + 100)));
  assert.equal(restarted.pending().find(request => request.id === "new_live")?.baseline, undefined);
  assert.equal(restarted.cancelTurn("other_turn"), false);
  assert.equal(restarted.cancelTurn("turn_a"), true);
  assert.deepEqual(restarted.pending().map(request => request.id), ["new_live"]);
});

test("question tracking is bounded and malformed tools/cache never introduce pending state", () => {
  const tracker = new CodexInputTracker();
  for (let index = 0; index < 200; index++) tracker.consume(codexInputRecord(call("call_" + index, undefined, 1)));
  assert.equal(tracker.snapshot().requests.length, 128); assert.equal(tracker.pending().length, 128);
  for (const invalid of [call("bad", "unrelated.request_user_input", 1), call("bad", undefined, 0), call("bad", undefined, 17),
    row({ type: "function_call", call_id: "bad", name: "request_user_input_async", arguments: "not json" })])
    assert.equal(codexInputRecord(invalid), undefined);
  assert.deepEqual(new CodexInputTracker({ version: 1, requests: [{ id: "malformed", answered: [] }] }).pending(), []);
});

async function fixture(t: { after(action: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "terminal-plus-codex-input-")), logs = join(directory, "sessions"), attentionPath = join(directory, "attention.json");
  await mkdir(logs); const events: CodexObservation[] = [], started = at - 100;
  const observers: CodexObserver[] = [];
  const observer = new CodexObserver(event => events.push(structuredClone(event)), { root: logs, now: started, attentionPath }); observers.push(observer);
  t.after(async () => { for (const item of observers) await item.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  async function session(parent?: string) {
    const id = randomUUID(), path = join(logs, `rollout-${id}.jsonl`);
    await writeFile(path, JSON.stringify(row({ id, cwd: directory, source: parent ? { subagent: {} } : "vscode", parent_thread_id: parent }, "session_meta")) + "\n");
    const append = (value: unknown) => appendFile(path, JSON.stringify(value) + "\n");
    const lifecycle = (type: string, turn: string, time = at) => append(row({ type, turn_id: turn }, "event_msg", time));
    return { id, path, append, lifecycle };
  }
  const latest = (id: string) => events.filter(event => event.state.session.id === id).at(-1)!.state;
  return { directory, logs, attentionPath, events, observer, observers, session, latest };
}

test("ordinary Desktop questions remain alongside working status and counts until complete exact replies", async t => {
  const f = await fixture(t), s = await f.session(); await s.lifecycle("task_started", "turn_a");
  await s.append(call()); await s.append(output("call_question", { accepted: true })); await f.observer.poll(true);
  assert.equal(f.latest(s.id).main.status, "running"); assert.equal(sessionAgentCount(f.latest(s.id), true), "1");
  assert.deepEqual(f.latest(s.id).attention, [{ id: "call_question", kind: "question", createdAt: at }]);
  await s.append(reply("call_question", [0])); await s.append(reply("call_question", [0], undefined, true)); await f.observer.poll();
  assert.equal(f.latest(s.id).attention?.length, 1); assert.equal(f.events.filter(event => event.completion).length, 0);
  await s.append(reply("call_question", [1], undefined, true)); await f.observer.poll();
  assert.deepEqual(f.latest(s.id).attention, []); assert.equal(f.latest(s.id).main.status, "running");
});

test("current title-only Desktop async request reaches observed attention and resolves only on its exact native reply", async t => {
  const f = await fixture(t), s = await f.session(); await s.lifecycle("task_started", "turn_native");
  await s.append(nativeAsync("desktop_title", ["PRIVATE NATIVE TITLE"]));
  await s.append(output("desktop_title", { accepted: true })); await f.observer.poll(true);
  assert.equal(f.latest(s.id).main.status, "running"); assert.equal(sessionAgentCount(f.latest(s.id), true), "1");
  assert.deepEqual(f.latest(s.id).attention, [{ id: "desktop_title", kind: "question", createdAt: at }]);
  assert.doesNotMatch(await readFile(f.attentionPath, "utf8"), /PRIVATE|"title"\s*:|"options"\s*:/);
  await s.append(reply("another_call", [0])); await f.observer.poll(); assert.equal(f.latest(s.id).attention?.length, 1);
  await s.append(reply("desktop_title", [0], undefined, true)); await f.observer.poll();
  assert.deepEqual(f.latest(s.id).attention, []); assert.equal(f.latest(s.id).main.status, "running");
});

test("pending questions defer job completion, and answering into a new turn never releases an old completed result", async t => {
  const f = await fixture(t), s = await f.session(); await s.lifecycle("task_started", "turn_a");
  await s.append(call(undefined, undefined, 1)); await s.lifecycle("task_complete", "turn_a"); await f.observer.poll(true);
  assert.equal(f.latest(s.id).main.status, "waiting"); assert.equal(f.events.filter(event => event.completion).length, 0);
  await s.append(reply("call_question", [0])); await s.lifecycle("task_started", "turn_b"); await f.observer.poll();
  assert.equal(f.latest(s.id).main.status, "running"); assert.equal(f.events.filter(event => event.completion).length, 0);
  await s.lifecycle("task_complete", "turn_b"); await f.observer.poll();
  assert.deepEqual(f.events.filter(event => event.completion).map(event => event.completion?.turnId), ["turn_b"]);
});

test("restart restores partial pending metadata outside a large tail as baseline without text or old completion", async t => {
  const f = await fixture(t), s = await f.session(); await s.lifecycle("task_started", "turn_a");
  await s.append(row({ model: "fixture-model" }, "turn_context")); await s.append(call()); await s.append(reply("call_question", [0])); await f.observer.poll(true);
  await s.append(row({ type: "custom_tool_call_output", output: "PRIVATE OUTPUT" + "x".repeat(3 * 1024 * 1024) }));
  const persisted = await readFile(f.attentionPath, "utf8"); assert.doesNotMatch(persisted, /PRIVATE|question_0/);
  const events: CodexObservation[] = [], restarted = new CodexObserver(event => events.push(structuredClone(event)), { root: f.logs, attentionPath: f.attentionPath });
  f.observers.push(restarted); await restarted.poll(true);
  assert.deepEqual(events.at(-1)?.state.attention, [{ id: "call_question", kind: "question", createdAt: at, baseline: true }]);
  assert.equal(events.filter(event => event.completion).length, 0);
  await s.append(reply("call_question", [1])); await restarted.poll(); assert.deepEqual(events.at(-1)?.state.attention, []);
});

test("uncached long-log questions retain only proven turn ownership and a later exact abort clears them", async t => {
  const f = await fixture(t), s = await f.session();
  await s.lifecycle("task_started", "turn_a"); await s.append(row({ model: "fixture-model" }, "turn_context"));
  await s.append(call("seeded_question", undefined, 1));
  await s.append(row({ type: "custom_tool_call_output", output: "x".repeat(3 * 1024 * 1024) }));
  await f.observer.poll(true);
  assert.deepEqual(f.latest(s.id).attention?.map(request => request.id), ["seeded_question"]);
  const saved = JSON.parse(await readFile(f.attentionPath, "utf8"));
  assert.equal(saved.sessions[0].input.requests[0].turnId, "turn_a");
  await s.lifecycle("turn_aborted", "turn_a"); await f.observer.poll();
  assert.deepEqual(f.latest(s.id).attention, []);
  assert.deepEqual(f.events.filter(event => event.completion).map(event => event.completion?.outcome), ["interrupted"]);
});

test("seeded historical abort closes its own question without claiming a request before the observed start", async t => {
  const f = await fixture(t), s = await f.session(), old = at - 20_000;
  await s.append(call("unknown_turn", undefined, 1, old));
  await s.lifecycle("task_started", "historical_turn", old); await s.append(row({ model: "fixture-model" }, "turn_context", old));
  await s.append(call("aborted_question", undefined, 1, old)); await s.lifecycle("turn_aborted", "historical_turn", old);
  await s.append(row({ type: "custom_tool_call_output", output: "x".repeat(3 * 1024 * 1024) }, undefined, old));
  await f.observer.poll(true);
  assert.deepEqual(f.latest(s.id).attention?.map(request => request.id), ["unknown_turn"]);
  assert.equal(f.events.filter(event => event.completion).length, 0);
});

test("fully answered historical questions do not become input alerts or revive through duplicate tool copies", async t => {
  const f = await fixture(t), s = await f.session(), old = at - 20_000;
  await s.lifecycle("task_started", "old", old); await s.append(call("old_call", undefined, 1, old));
  await s.append({ ...reply("old_call", [0]), timestamp: new Date(old).toISOString() }); await s.lifecycle("task_complete", "old", old);
  await f.observer.poll(true); assert.equal(f.events.length, 0);
  await s.append(call("old_call", undefined, 1)); await f.observer.poll(); assert.equal(f.events.length, 0);
});

test("abort clears only matching-turn questions, and tool failure never changes working lifecycle", async t => {
  const f = await fixture(t), s = await f.session(); await s.lifecycle("task_started", "turn_a"); await s.append(call("a", undefined, 1));
  await s.lifecycle("task_started", "turn_b"); await s.append(call("b", undefined, 1)); await f.observer.poll(true);
  await s.lifecycle("turn_aborted", "other"); await f.observer.poll(); assert.equal(f.latest(s.id).attention?.length, 2);
  await s.lifecycle("turn_aborted", "turn_b"); await f.observer.poll(); assert.deepEqual(f.latest(s.id).attention?.map(request => request.id), ["a"]);
  await s.lifecycle("task_started", "turn_c"); await s.append(output("a", { accepted: false })); await f.observer.poll();
  assert.deepEqual(f.latest(s.id).attention, []); assert.equal(f.latest(s.id).main.status, "running");
});

test("verified child questions reach only the parent's watched session and copied parent questions cannot masquerade as child requests", async t => {
  const f = await fixture(t), parent = await f.session(), child = await f.session(parent.id);
  await parent.lifecycle("task_started", "parent_turn"); await parent.append(call("parent_call", undefined, 1));
  await child.lifecycle("task_started", "parent_turn"); await child.append(call("parent_call", undefined, 1));
  await child.lifecycle("task_started", "child_turn"); await child.append(call("child_call", undefined, 1)); await f.observer.poll(true);
  assert.equal(f.events.some(event => event.state.session.id === child.id), false);
  assert.deepEqual(f.latest(parent.id).attention?.map(request => request.id), ["parent_call", `${child.id}:child_call`]);
  assert.equal(sessionAgentCount(f.latest(parent.id), true), "2", "question tracking does not invent agents or lower active counts");
  await child.append(reply("child_call", [0])); await f.observer.poll();
  assert.deepEqual(f.latest(parent.id).attention?.map(request => request.id), ["parent_call"]);
});
