import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { NativeClaudeQuestions, type NativeClaudeQuestionSession } from "../packages/connectors/claude-native-questions.js";
import { waitForNativeClaudeQuestion, readClaudeQuestionFile, readNativeQuestionAvailability,
  readNativeQuestionRequest, listNativeQuestionRequests, writeClaudeQuestionFile,
  type NativeClaudeQuestionRequest, type NativeClaudeHookOutput } from "../apps/windows/src/claude-native-question.mjs";

function questionAnswers(output: NativeClaudeHookOutput | undefined) {
  assert.ok(output && "updatedInput" in output.hookSpecificOutput);
  return output.hookSpecificOutput.updatedInput.answers;
}

async function until(check: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Synthetic native question fixture timed out"); await delay(5); }
}

async function fixture(t: any, options: { canAnswer?: boolean; monitored?: boolean; multi?: boolean; timeout?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "terminal-plus-native-questions-controller-"));
  const data = join(root, "data"); await mkdir(data, { mode: 0o700 });
  const owner = { pid: 101, started: "111" }, hook = { pid: 103, started: "333" };
  const identities = new Map([[process.pid, "222"], [owner.pid, owner.started], [hook.pid, hook.started]]);
  const identify = async (pid: number) => identities.get(pid);
  const sessionId = randomUUID(), eventId = randomUUID();
  const attention = { id: "native-question-" + eventId, kind: "question", toolId: "toolu_fixture", createdAt: Date.now() - 1 };
  const session: NativeClaudeQuestionSession = { id: sessionId, key: "claude:" + sessionId, owner, path: join(root, "session.jsonl"),
    cwd: root, online: true, monitored: options.monitored ?? true, canAnswer: options.canAnswer ?? true, attention: [attention] };
  const questions = [{ question: "Which synthetic fixtures?", header: "Fixture", options: [
    { label: "Alpha", description: "First fixture" }, { label: "Beta", description: "Second fixture" },
    { label: "Gamma", description: "Third fixture" }], multiSelect: options.multi ?? false }];
  const input = { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: attention.toolId,
    tool_input: { questions, privateArgument: "UNRELATED_ARGUMENT_MUST_NOT_ENTER_SPOOL" } };
  const event = { eventId, at: attention.createdAt, session_id: session.id, transcript_path: session.path, cwd: session.cwd };
  const changes: { sessionId: string; answeredId?: string }[] = [], helpers: Promise<any>[] = [];
  let sessions = [session];
  const controller = new NativeClaudeQuestions(data, () => sessions,
    (sessionId, answeredId) => changes.push({ sessionId, answeredId }), { identify });
  t.after(async () => { await controller.stop(); await Promise.allSettled(helpers); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const start = () => {
    const pending = waitForNativeClaudeQuestion(data, input, event, owner,
      { identify, hookPid: hook.pid, timeout: options.timeout ?? 2000, pollMs: 10, discoveryGraceMs: 0 });
    helpers.push(pending); return pending;
  };
  async function admit() {
    await controller.poll();
    const result = start();
    await until(() => !!readNativeQuestionRequest(data, eventId));
    const request = readNativeQuestionRequest(data, eventId)!;
    await controller.poll();
    assert.equal(controller.interactions(session.id).length, 1);
    assert.equal(controller.interactions(session.id)[0].id, attention.id, "Question reply uses the accepted lifecycle attention identity");
    return { result, request };
  }
  async function privateSpoolEmpty() {
    await until(() => listNativeQuestionRequests(data).length === 0);
    await controller.poll();
    assert.deepEqual((await readdir(join(data, "claude-questions"))).filter(name => name !== "availability.json"), []);
  }
  return { root, data, session, event, eventId, input, questions, owner, hook, identities, identify, attention, changes, controller,
    start, admit, privateSpoolEmpty, replaceSessions: (value: NativeClaudeQuestionSession[]) => { sessions = value; } };
}

test("ordinary Claude native questions are acknowledged once without owning prompts or task lifecycle", async t => {
  const f = await fixture(t), { result, request } = await f.admit();
  assert.equal(JSON.stringify(request).includes("UNRELATED_ARGUMENT_MUST_NOT_ENTER_SPOOL"), false);
  const savedAttention = structuredClone(f.session.attention);
  const sending = f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "choice:1" } });
  await assert.rejects(f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "choice:0" } }), /no longer available|expired|already/);
  const output = await result; await sending;
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { questions: f.questions, answers: { [f.questions[0].question]: "Beta" } } } });
  assert.equal(f.changes.filter(row => row.answeredId === f.attention.id).length, 1);
  assert.deepEqual(f.session.attention, savedAttention, "The controller does not invent a native lifecycle transition");
  assert.deepEqual(f.controller.interactions(f.session.id), []);
  await assert.rejects(f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "choice:0" } }), /no longer available/);
  await f.privateSpoolEmpty();
});

test("native multi-select uses existing choices or the text editor for 1,3 and custom answers", async t => {
  for (const [answer, expected] of [["1,3", "Alpha, Gamma"], ["Use Alpha after review", "Use Alpha after review"], ["choice:1", "Beta"]]) {
    const f = await fixture(t, { multi: true }), { result } = await f.admit();
    const question = f.controller.interactions(f.session.id)[0].questions[0];
    assert.equal(question.allowText, true); assert.equal((question as any).multiSelect, true);
    await f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: answer } });
    assert.equal(questionAnswers(await result)[f.questions[0].question], expected);
    await f.privateSpoolEmpty();
  }
});

test("an invalid multi-select number does not claim the question or block a corrected answer", async t => {
  const f = await fixture(t, { multi: true }), { result } = await f.admit();
  await assert.rejects(f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "1,4" } }), /displayed option numbers/);
  assert.equal(f.controller.interactions(f.session.id).length, 1);
  await f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "1,3" } });
  assert.equal(questionAnswers(await result)[f.questions[0].question], "Alpha, Gamma");
  await f.privateSpoolEmpty();
});

test("unwatched sessions and sessions without an active answer viewer never block the native CLI", async t => {
  for (const options of [{ monitored: false }, { canAnswer: false }]) {
    const f = await fixture(t, options); await f.controller.poll();
    assert.equal(readNativeQuestionAvailability(f.data)?.sessions[0].monitored, false);
    assert.equal(await f.start(), undefined);
    assert.deepEqual(f.controller.interactions(f.session.id), []);
    assert.deepEqual(listNativeQuestionRequests(f.data), []);
    assert.equal(f.changes.length, 0);
    await f.privateSpoolEmpty();
  }
});

test("an admitted question survives loss of its viewer lease and can still be explicitly answered", async t => {
  const f = await fixture(t), { result } = await f.admit();
  f.session.canAnswer = false;
  await f.controller.poll();
  assert.equal(readNativeQuestionAvailability(f.data)?.sessions[0].monitored, true, "Admission survives viewer disconnect");
  assert.equal(f.controller.interactions(f.session.id).length, 1);
  await f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "choice:0" } });
  assert.equal(questionAnswers(await result)[f.questions[0].question], "Alpha");
  await f.controller.poll();
  assert.equal(readNativeQuestionAvailability(f.data)?.sessions[0].monitored, false, "A disconnected viewer does not admit the next question");
  await f.privateSpoolEmpty();
});

test("explicit remote cancel returns native control without answering or clearing lifecycle attention", async t => {
  const f = await fixture(t), { result } = await f.admit();
  const attention = structuredClone(f.session.attention);
  await f.controller.respond(f.session.key, { requestId: f.attention.id, answers: {}, cancel: true });
  assert.equal(await result, undefined);
  assert.equal(f.changes.some(row => row.answeredId), false);
  assert.deepEqual(f.session.attention, attention);
  await f.privateSpoolEmpty();
});

test("unwatch after admission falls back to the native question without clearing its attention", async t => {
  const f = await fixture(t), { result } = await f.admit();
  const attention = structuredClone(f.session.attention);
  f.session.monitored = false; await f.controller.poll();
  assert.equal(await result, undefined);
  assert.deepEqual(f.controller.interactions(f.session.id), []);
  assert.deepEqual(f.session.attention, attention);
  assert.equal(f.changes.some(row => row.answeredId), false);
  await f.privateSpoolEmpty();
});

test("expired native questions retire remotely without sending an answer or a completed signal", async t => {
  const f = await fixture(t, { timeout: 150 }), { result, request } = await f.admit();
  await delay(Math.max(1, request.expiresAt - Date.now() + 5));
  assert.equal(await result, undefined); await f.controller.poll();
  await assert.rejects(f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "choice:0" } }), /no longer available/);
  assert.deepEqual(f.controller.interactions(f.session.id), []);
  assert.equal(f.changes.some(row => row.answeredId), false);
  await f.privateSpoolEmpty();
});

test("quick rewatch cannot admit the same question after native fallback was requested", async t => {
  const f = await fixture(t), { result } = await f.admit();
  f.session.monitored = false; await f.controller.poll();
  f.session.monitored = true; await f.controller.poll();
  assert.deepEqual(f.controller.interactions(f.session.id), []);
  assert.equal(await result, undefined);
  assert.equal(f.changes.some(row => row.answeredId), false);
  assert.equal(f.session.attention.length, 1);
  await f.privateSpoolEmpty();
});

test("answers stay bound to the native session, turn, transcript, cwd, owner and question lifecycle", async t => {
  const mutations: [string, (f: Awaited<ReturnType<typeof fixture>>, request: NativeClaudeQuestionRequest) => void][] = [
    ["later turn", (f, request) => { f.session.turnAt = request.at + 1; }],
    ["session removed", f => { f.replaceSessions([]); }],
    ["new session id", f => { f.session.id = randomUUID(); }],
    ["new session key", f => { f.session.key = "claude:" + randomUUID(); }],
    ["different transcript", f => { f.session.path = join(f.root, "other.jsonl"); }],
    ["different project", f => { f.session.cwd = join(f.root, "other"); }],
    ["owner replaced", f => { f.session.owner = { ...f.owner, started: "999" }; }],
    ["owner PID recycled", f => { f.identities.set(f.owner.pid, "999"); }],
    ["hook PID recycled", f => { f.identities.set(f.hook.pid, "999"); }],
    ["session offline", f => { f.session.online = false; }],
    ["different question", f => { f.session.attention = [{ ...f.attention, toolId: "toolu_other" }]; }],
    ["different lifecycle event", f => { f.session.attention = [{ ...f.attention, createdAt: f.attention.createdAt - 1 }]; }],
  ];
  for (const [name, mutate] of mutations) {
    const f = await fixture(t), { result, request } = await f.admit(), key = f.session.key;
    mutate(f, request);
    await assert.rejects(f.controller.respond(key, { requestId: f.attention.id, answers: { q0: "choice:0" } }),
      /no longer available|changed|stopped|original terminal/, name);
    await f.controller.poll(); await f.controller.stop();
    assert.equal(await result, undefined, name);
    assert.equal(f.changes.some(row => row.answeredId), false, name);
  }
});

test("a request cannot be answered using a different key, attention id, nonce or backend instance", async t => {
  for (const mode of ["key", "request id", "nonce", "backend instance"] as const) {
    const f = await fixture(t), { result, request } = await f.admit();
    if (mode === "nonce" || mode === "backend instance") {
      const changed = structuredClone(request);
      if (mode === "nonce") changed.nonce = "a".repeat(64);
      else changed.backend.instance = randomUUID();
      assert.equal(writeClaudeQuestionFile(f.data, f.eventId + ".request.json", changed), true);
    }
    await assert.rejects(f.controller.respond(mode === "key" ? "other-key" : f.session.key,
      { requestId: mode === "request id" ? "other-request" : f.attention.id, answers: { q0: "choice:0" } }),
      /no longer available|changed|original terminal/, mode);
    await f.controller.stop(); assert.equal(await result, undefined);
    assert.equal(f.changes.some(row => row.answeredId), false);
    assert.equal(readClaudeQuestionFile(f.data, f.eventId + ".consumed.json")?.action === "answer", false);
  }
});

test("another live backend does not take ownership of this backend's pending native question", async t => {
  const f = await fixture(t), { result } = await f.admit();
  const other = new NativeClaudeQuestions(f.data, () => [f.session], () => assert.fail("A foreign backend must not publish a question"), { identify: f.identify });
  t.after(() => other.stop());
  const original = readNativeQuestionAvailability(f.data)!;
  await other.poll();
  assert.deepEqual(other.interactions(f.session.id), []);
  assert.deepEqual(readNativeQuestionAvailability(f.data), original);
  await assert.rejects(other.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "choice:1" } }), /no longer available/);
  await f.controller.respond(f.session.key, { requestId: f.attention.id, answers: { q0: "choice:0" } });
  assert.equal(questionAnswers(await result)[f.questions[0].question], "Alpha");
  await f.privateSpoolEmpty();
});
