import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, chmod, link, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitForNativeClaudeQuestion, writeClaudeQuestionAvailability, readClaudeQuestionRequest, writeClaudeQuestionResponse,
  readClaudeQuestionFile, writeClaudeQuestionFile, readNativeQuestionConsumed, cleanupNativeQuestion,
  listNativeQuestionRequests, removeNativeQuestionAvailability, validClaudeQuestionRequest,
  claudeQuestionRequestAlive, claudeQuestionProcessIdentity, pruneNativeQuestionFiles,
  nativeClaudePermission, nativeClaudePermissionOutput, nativeClaudeRequestOutput, CLAUDE_PERMISSION_PREVIEW_BYTES,
  type NativeClaudeQuestionRequest } from "../apps/windows/src/claude-native-question.mjs";

async function fixture(t: any, multiSelect = false) {
  const root = await mkdtemp(join(tmpdir(), "terminal-plus-native-question-"));
  const data = join(root, "data"); await mkdir(data, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.now();
  const owner = { pid: 101, started: "111" }, backend = { pid: 102, started: "222" }, hook = { pid: 103, started: "333" };
  const instance = randomUUID(), sessionId = randomUUID(), eventId = randomUUID();
  const questions = [{ question: "Which fixtures?", header: "Choice", options: [
    { label: "Alpha", description: "First fixture" }, { label: "Beta", description: "Second fixture" },
    { label: "Gamma", description: "Third fixture" }], multiSelect }];
  const event = { eventId, session_id: sessionId, transcript_path: join(root, "session.jsonl"), cwd: root };
  const input = { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_fixture", tool_input: { questions, privateArgument: "DO_NOT_RETAIN" } };
  const availability = (monitored = true, rows?: any[]) => writeClaudeQuestionAvailability(data,
    { version: 1, at: now, backend, instance, sessions: rows || [{ sessionId, owner, monitored }] });
  const identify = async (pid: number) => [owner, backend, hook].find(row => row.pid === pid)?.started;
  const options = { now: () => now, identify, hookPid: hook.pid, timeout: 2000, pollMs: 100, discoveryGraceMs: 0 };
  const advance = (ms: number) => { now += ms; };
  const request = () => readClaudeQuestionRequest(data, eventId, now)!;
  return { root, data, owner, backend, hook, instance, sessionId, eventId, questions, event, input, availability, identify, options, advance, request, now: () => now };
}

test("native single/multi questions output only the explicit bound answer, with a consumable receipt", async t => {
  for (const [multi, answer] of [[false, "Beta"], [true, "Alpha, Gamma"], [true, "Use Alpha and Gamma with the first optional step"]] as const) {
    const f = await fixture(t, multi); assert.equal(f.availability(), true);
    let sent = false, saved: NativeClaudeQuestionRequest | undefined;
    const output = await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, { ...f.options, sleep: async ms => {
      f.advance(ms);
      if (!sent) { saved = f.request(); assert.ok(saved); assert.equal(JSON.stringify(saved).includes("DO_NOT_RETAIN"), false);
        assert.equal(writeClaudeQuestionResponse(f.data, saved, "answer", { [f.questions[0].question]: answer }, f.now()), true);
        assert.equal(writeClaudeQuestionResponse(f.data, saved, "answer", { [f.questions[0].question]: "Alpha" }, f.now()), false);
        sent = true;
      }
    } });
    assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: {
      questions: f.questions, answers: { [f.questions[0].question]: answer } } } });
    assert.deepEqual(listNativeQuestionRequests(f.data), []);
    assert.equal(readClaudeQuestionFile(f.data, f.eventId + ".response.json"), undefined);
    const ack = readNativeQuestionConsumed(f.data, saved!); assert.equal(ack?.action, "answer");
    assert.equal(ack?.nonce, saved!.nonce); assert.equal(ack?.backend.instance, f.instance);
    assert.equal(writeClaudeQuestionResponse(f.data, saved!, "answer", { [f.questions[0].question]: answer }, f.now()), false,
      "An already consumed/deleted hook request cannot accept a second response");
    cleanupNativeQuestion(f.data, saved!, { includeAck: true });
    assert.equal(readNativeQuestionConsumed(f.data, saved!), undefined);
  }
});

test("native tool permission keeps the full action preview and returns only an explicit allow/deny once", async t => {
  for (const decision of ["allow", "deny"] as const) {
    const f = await fixture(t); f.availability();
    const toolInput = { command: "printf '%s' fixture", description: "Full proposed action", timeout: 1000,
      nested: { path: join(f.root, "exact-target"), private: "FULL_ACTION_MUST_BE_VISIBLE" } };
    const input = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: toolInput,
      permission_suggestions: [{ type: "addRules", rules: ["Bash(*)"], behavior: "allow", destination: "userSettings" }],
      tool_use_id: "not-officially-guaranteed" };
    let saved: NativeClaudeQuestionRequest | undefined;
    const output = await waitForNativeClaudeQuestion(f.data, input, { ...f.event, at: f.now() }, f.owner,
      { ...f.options, sleep: async ms => {
        f.advance(ms); if (saved) return;
        saved = f.request(); assert.ok(saved);
        assert.equal(saved.kind, "approval"); assert.equal(saved.lifecycleAt, saved.at);
        assert.equal(saved.toolUseId, saved.eventId, "A missing native permission tool id is replaced by the event binding");
        assert.deepEqual(saved.input, { permission: { toolName: "Bash", toolInput } });
        assert.equal(JSON.stringify(saved).includes("permission_suggestions"), false);
        assert.equal(writeClaudeQuestionResponse(f.data, saved, "answer", { decision }, f.now()), true);
        assert.equal(writeClaudeQuestionResponse(f.data, saved, "answer", { decision: "allow" }, f.now()), false);
      } });
    assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: decision } } });
    assert.equal(JSON.stringify(output).includes("updatedPermissions"), false, "A reply never installs a persistent permission rule");
    assert.equal(readNativeQuestionConsumed(f.data, saved!)?.answers?.decision, decision);
    assert.deepEqual(listNativeQuestionRequests(f.data), []);
  }
});

test("permission previews are byte bounded without truncation; question text cannot become a permission decision", async t => {
  const base = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "中".repeat(2000) } };
  const permission = nativeClaudePermission(base); assert.deepEqual(permission, { toolName: base.tool_name, toolInput: base.tool_input });
  assert.ok(Buffer.byteLength(JSON.stringify(permission)) < CLAUDE_PERMISSION_PREVIEW_BYTES);
  assert.equal(nativeClaudePermission({ ...base, tool_input: { command: "中".repeat(CLAUDE_PERMISSION_PREVIEW_BYTES / 2) } }), undefined);
  for (const invalid of [{ ...base, hook_event_name: "PreToolUse" }, { ...base, tool_name: "AskUserQuestion" },
    { ...base, tool_input: null }, { ...base, tool_input: [] }, { ...base, tool_name: "bad\0name" }])
    assert.equal(nativeClaudePermission(invalid), undefined);
  assert.equal(nativeClaudePermissionOutput(permission!, "allow")?.hookSpecificOutput.decision.behavior, "allow");
  assert.equal(nativeClaudePermissionOutput(permission!, "ask" as any), undefined);
  const question = { input: { questions: [{ question: "Fixture?", options: [{ label: "A" }, { label: "B" }] }] } };
  const approval = { kind: "approval" as const, input: { permission: permission! } };
  assert.equal(nativeClaudeRequestOutput(question, { decision: "allow" }), undefined);
  assert.equal(nativeClaudeRequestOutput(approval, { "Fixture?": "A" }), undefined);
  assert.equal(nativeClaudeRequestOutput(approval, { decision: "allow", additional: "yes" }), undefined);
  assert.equal(nativeClaudeRequestOutput({ kind: "question", input: approval.input }, { decision: "allow" }), undefined);
  assert.equal(nativeClaudeRequestOutput({ kind: "approval", input: question.input }, { "Fixture?": "A" }), undefined);

  const f = await fixture(t); f.availability(); let slept = false;
  assert.equal(await waitForNativeClaudeQuestion(f.data, { ...base, tool_input: { command: "x".repeat(20_001) } }, f.event, f.owner,
    { ...f.options, sleep: async () => { slept = true; } }), undefined);
  assert.equal(slept, false); assert.deepEqual(listNativeQuestionRequests(f.data), []);
});

test("permission expiry, cancel, unwatch, owner changes and cross-kind replies always return to the native prompt", async t => {
  for (const mode of ["expire", "cancel", "unwatch", "owner-reused", "cross-kind", "free-text"] as const) {
    const f = await fixture(t); f.availability();
    const input = { hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: { file_path: join(f.root, "fixture"), content: "exact content" } };
    let saved: NativeClaudeQuestionRequest | undefined, ownerChanged = false;
    const output = await waitForNativeClaudeQuestion(f.data, input, f.event, f.owner, { ...f.options,
      identify: pid => ownerChanged && pid === f.owner.pid ? Promise.resolve("different-start") : f.identify(pid),
      sleep: async ms => {
        f.advance(ms); if (mode === "expire" || saved) return;
        saved = f.request();
        if (mode === "cancel") assert.equal(writeClaudeQuestionResponse(f.data, saved, "cancel", undefined, f.now()), true);
        if (mode === "unwatch") f.availability(false);
        if (mode === "owner-reused") {
          assert.equal(writeClaudeQuestionResponse(f.data, saved, "answer", { decision: "allow" }, f.now()), true); ownerChanged = true;
        }
        if (mode === "free-text") assert.equal(writeClaudeQuestionResponse(f.data, saved, "answer", { decision: "I will answer later" }, f.now()), false);
        if (mode === "cross-kind") {
          assert.equal(writeClaudeQuestionResponse(f.data, saved, "answer", { decision: "allow" }, f.now()), true);
          const response = readClaudeQuestionFile(f.data, f.eventId + ".response.json");
          response.kind = "question";
          assert.equal(writeClaudeQuestionFile(f.data, f.eventId + ".response.json", response), true);
        }
      } });
    assert.equal(output, undefined, mode); assert.deepEqual(listNativeQuestionRequests(f.data), [], mode);
    assert.equal(!!readClaudeQuestionFile(f.data, f.eventId + ".consumed.json"), mode === "cancel", mode);
  }
});

test("retiring or changing a pending request releases the hook immediately even while Watch stays healthy", async t => {
  for (const mode of ["removed", "nonce", "binding", "input", "at", "path"] as const) {
    const f = await fixture(t); f.availability(); const started = f.now(); let sleeps = 0;
    const result = await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, { ...f.options, timeout: 300_000,
      sleep: async ms => {
        f.advance(ms); sleeps++;
        const request = f.request(); assert.ok(request);
        if (mode === "removed") await rm(join(f.data, "claude-questions", f.eventId + ".request.json"));
        else {
          if (mode === "nonce") request.nonce = "a".repeat(64);
          if (mode === "binding") request.hook = { ...request.hook, started: "999" };
          if (mode === "input") request.input.questions![0].question = "A different question";
          if (mode === "at") request.at++;
          if (mode === "path") request.transcriptPath = join(f.root, "other-session.jsonl");
          assert.equal(writeClaudeQuestionFile(f.data, f.eventId + ".request.json", request), true);
        }
        assert.equal(f.availability(), true, "Watch and backend heartbeat remain healthy");
      } });
    assert.equal(result, undefined, mode); assert.equal(sleeps, 1, mode);
    assert.equal(f.now() - started, 100, mode);
    assert.equal(readClaudeQuestionFile(f.data, f.eventId + ".consumed.json"), undefined, mode);
    assert.deepEqual(listNativeQuestionRequests(f.data), [], mode);
  }
});

test("stopped/unwatched/foreign-owner sessions and non-question tools never wait or spool input", async t => {
  const f = await fixture(t); let slept = 0;
  const options = { ...f.options, discoveryGraceMs: 2000, sleep: async (ms: number) => { slept++; f.advance(ms); } };
  assert.equal(await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, options), undefined);
  f.availability(false);
  assert.equal(await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, options), undefined);
  f.availability(true, [{ sessionId: f.sessionId, owner: { ...f.owner, started: "recycled" }, monitored: true }]);
  assert.equal(await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, options), undefined);
  f.availability();
  for (const bad of [{ ...f.input, tool_name: "Bash" }, { ...f.input, hook_event_name: "PermissionRequest" },
    { ...f.input, agent_id: "child" }, { ...f.input, tool_use_id: "../other" }, { ...f.input, tool_input: { questions: [] } }])
    assert.equal(await waitForNativeClaudeQuestion(f.data, bad, f.event, f.owner, options), undefined);
  assert.equal(slept, 0); assert.deepEqual(listNativeQuestionRequests(f.data), []);
});

test("first-seen session gets only a bounded discovery grace; native lifecycle remains the event source", async t => {
  const f = await fixture(t); f.availability(true, []); let sleeps = 0;
  const output = await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, { ...f.options, timeout: 3000, discoveryGraceMs: 2000,
    sleep: async ms => { f.advance(ms); sleeps++; if (sleeps === 2) f.availability();
      const request = f.request(); if (request) writeClaudeQuestionResponse(f.data, request, "answer", { [f.questions[0].question]: "Alpha" }, f.now()); } });
  assert.ok(output && "updatedInput" in output.hookSpecificOutput);
  assert.equal(output.hookSpecificOutput.updatedInput.answers[f.questions[0].question], "Alpha");
  const missed = await fixture(t); missed.availability(true, []); const started = missed.now();
  assert.equal(await waitForNativeClaudeQuestion(missed.data, missed.input, missed.event, missed.owner,
    { ...missed.options, discoveryGraceMs: 2000, sleep: async ms => { missed.advance(ms); } }), undefined);
  assert.equal(missed.now() - started, 2000); assert.deepEqual(listNativeQuestionRequests(missed.data), []);
});

test("cancel/expiry/backend loss/unwatch/PID reuse cannot fabricate a question answer", async t => {
  for (const mode of ["cancel", "expiry", "expiry-during-check", "backend-gone", "owner-reused", "hook-reused", "backend-restarted", "unwatch", "stale-heartbeat"] as const) {
    const f = await fixture(t); f.availability(); let changed = false, ownerGone = false, backendGone = false, hookGone = false, expireOnCheck = false;
    const output = await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, { ...f.options, timeout: mode === "stale-heartbeat" ? 10_000 : 2000,
      identify: async pid => {
        if (expireOnCheck && pid === f.owner.pid) f.advance(2000);
        return ownerGone && pid === f.owner.pid ? "different-start" : backendGone && pid === f.backend.pid ? undefined
          : hookGone && pid === f.hook.pid ? "different-hook" : f.identify(pid);
      },
      sleep: async ms => {
        f.advance(ms); const request = f.request();
        if (mode === "expiry") return;
        if (mode === "stale-heartbeat") { f.advance(5000); return; }
        if (changed) return; changed = true;
        if (mode === "cancel") writeClaudeQuestionResponse(f.data, request, "cancel", undefined, f.now());
        if (mode === "expiry-during-check") { writeClaudeQuestionResponse(f.data, request, "answer", { [f.questions[0].question]: "Alpha" }, f.now()); expireOnCheck = true; }
        if (mode === "backend-gone") { backendGone = true; writeClaudeQuestionResponse(f.data, request, "answer", { [f.questions[0].question]: "Alpha" }, f.now()); }
        if (mode === "owner-reused") { ownerGone = true; writeClaudeQuestionResponse(f.data, request, "answer", { [f.questions[0].question]: "Alpha" }, f.now()); }
        if (mode === "hook-reused") { hookGone = true; writeClaudeQuestionResponse(f.data, request, "answer", { [f.questions[0].question]: "Alpha" }, f.now()); }
        if (mode === "unwatch") f.availability(false);
        if (mode === "backend-restarted") writeClaudeQuestionAvailability(f.data,
          { version: 1, at: f.now(), backend: f.backend, instance: randomUUID(), sessions: [{ sessionId: f.sessionId, owner: f.owner, monitored: true }] });
      } });
    assert.equal(output, undefined, mode); assert.deepEqual(listNativeQuestionRequests(f.data), [], mode);
    assert.equal(readClaudeQuestionFile(f.data, f.eventId + ".response.json"), undefined, mode);
    assert.equal(!!readClaudeQuestionFile(f.data, f.eventId + ".consumed.json"), mode === "cancel", mode);
  }
});

test("response bindings, answer shape and owner/expiry validation reject stale or cross-session answers", async t => {
  const variations = ["nonce", "sessionId", "toolUseId", "owner", "hook", "backend", "expiresAt", "at", "answers", "kind", "lifecycleAt"] as const;
  for (const key of variations) {
    const f = await fixture(t); f.availability(); let sent = false;
    const result = await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, { ...f.options, sleep: async ms => {
      f.advance(ms); if (sent) return; sent = true;
      const request = f.request(); assert.equal(writeClaudeQuestionResponse(f.data, request, "answer", { [f.questions[0].question]: "Alpha" }, f.now()), true);
      const response = readClaudeQuestionFile(f.data, f.eventId + ".response.json");
      if (key === "expiresAt") response.expiresAt++;
      else if (key === "at") response.at = request.expiresAt;
      else if (key === "answers") response.answers = { "Wrong question": "Alpha" };
      else if (key === "kind") response.kind = "approval";
      else if (key === "lifecycleAt") response.lifecycleAt++;
      else if (["owner", "hook", "backend"].includes(key)) response[key] = { ...response[key], started: "999" };
      else response[key] = "foreign";
      assert.equal(writeClaudeQuestionFile(f.data, f.eventId + ".response.json", response), true);
    } });
    assert.equal(result, undefined, key); assert.equal(readClaudeQuestionFile(f.data, f.eventId + ".consumed.json"), undefined, key);
  }
});

test("private question I/O refuses hard links, wide permissions and arbitrary paths; owned availability removal is exact", async t => {
  const f = await fixture(t); f.availability();
  assert.equal(writeClaudeQuestionFile(f.data, "../foreign", {}), false);
  assert.equal(readClaudeQuestionFile(f.data, "../foreign"), undefined);
  const availabilityPath = join(f.data, "claude-questions", "availability.json");
  await link(availabilityPath, join(f.data, "hardlink"));
  assert.equal(readClaudeQuestionFile(f.data, "availability.json"), undefined);
  assert.equal(writeClaudeQuestionFile(f.data, "availability.json", {}), false);
  await rm(join(f.data, "hardlink"));
  if (process.platform === "linux") {
    await chmod(availabilityPath, 0o644); assert.equal(readClaudeQuestionFile(f.data, "availability.json"), undefined);
    await chmod(availabilityPath, 0o600);
  }
  assert.equal(removeNativeQuestionAvailability(f.data, randomUUID()), false);
  assert.equal(removeNativeQuestionAvailability(f.data, f.instance), true);
  assert.equal(await readFile(availabilityPath, "utf8").catch(() => "absent"), "absent");
});

test("bounded queue refuses stopped-companion accumulation and immutable hook identity is checked separately", async t => {
  const f = await fixture(t); f.availability();
  for (let index = 0; index < 128; index++) assert.equal(writeClaudeQuestionFile(f.data, randomUUID() + ".request.json", {}, true), true);
  let slept = false;
  assert.equal(await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner,
    { ...f.options, sleep: async () => { slept = true; } }), undefined);
  assert.equal(slept, false); assert.equal((await readdir(join(f.data, "claude-questions"))).length, 129);
  const request = { version: 1 as const, eventId: f.eventId, nonce: "1".repeat(64), at: f.now(), expiresAt: f.now() + 1000,
    sessionId: f.sessionId, toolUseId: "toolu_fixture", transcriptPath: f.event.transcript_path, cwd: f.root,
    owner: f.owner, hook: f.hook, backend: { ...f.backend, instance: f.instance }, input: { questions: f.questions } };
  assert.equal(validClaudeQuestionRequest(request, f.now()), true);
  assert.equal(await claudeQuestionRequestAlive(request, f.identify), true);
  assert.equal(await claudeQuestionRequestAlive(request, async pid => pid === f.hook.pid ? "recycled" : f.identify(pid)), false);
  assert.equal(validClaudeQuestionRequest({ ...request, expiresAt: request.at + 300_001 }, f.now()), false);
  await writeFile(join(f.data, "claude-questions", randomUUID() + ".request.json"), "oversized".repeat(20_000), { mode: 0o600 });
});

test("restart pruning removes only expired private identity-bound artifacts, preserving live replies and unrelated files", async t => {
  const f = await fixture(t); f.availability(); let request: NativeClaudeQuestionRequest | undefined;
  await waitForNativeClaudeQuestion(f.data, f.input, f.event, f.owner, { ...f.options, sleep: async ms => {
    f.advance(ms); request = f.request(); writeClaudeQuestionResponse(f.data, request, "answer", { [f.questions[0].question]: "Alpha" }, f.now());
  } });
  assert.ok(request); assert.equal(pruneNativeQuestionFiles(f.data, f.now()), 0);
  const liveId = randomUUID(), staleId = randomUUID(), hardId = randomUUID(), invalidId = randomUUID();
  const live = { ...request, eventId: liveId, at: f.now(), expiresAt: f.now() + 10_000 };
  assert.equal(writeClaudeQuestionFile(f.data, liveId + ".request.json", live, true), true);
  const stale = { ...request, eventId: staleId };
  assert.equal(writeClaudeQuestionFile(f.data, staleId + ".request.json", stale, true), true);
  const hard = { ...request, eventId: hardId };
  assert.equal(writeClaudeQuestionFile(f.data, hardId + ".request.json", hard, true), true);
  await link(join(f.data, "claude-questions", hardId + ".request.json"), join(f.data, "protected-hardlink"));
  assert.equal(writeClaudeQuestionFile(f.data, invalidId + ".request.json", { ...stale, eventId: invalidId, nonce: "bad" }, true), true);
  await writeFile(join(f.data, "claude-questions", "user-notes.txt"), "preserve", { mode: 0o600 });
  f.advance(2000);
  assert.equal(pruneNativeQuestionFiles(f.data, f.now()), 2, "Expired receipt and request only");
  assert.equal(readNativeQuestionConsumed(f.data, request), undefined);
  assert.ok(readClaudeQuestionRequest(f.data, liveId, f.now()));
  assert.equal(await readFile(join(f.data, "claude-questions", "user-notes.txt"), "utf8"), "preserve");
  assert.ok((await readdir(join(f.data, "claude-questions"))).includes(hardId + ".request.json"));
  assert.ok((await readdir(join(f.data, "claude-questions"))).includes(invalidId + ".request.json"));
});

test("expired permission receipts are pruned only for identity-bound explicit decisions", async t => {
  const f = await fixture(t); f.availability(); let request: NativeClaudeQuestionRequest | undefined;
  const input = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "fixture" } };
  assert.ok(await waitForNativeClaudeQuestion(f.data, input, f.event, f.owner, { ...f.options, sleep: async ms => {
    f.advance(ms); request = f.request();
    assert.equal(writeClaudeQuestionResponse(f.data, request, "answer", { decision: "deny" }, f.now()), true);
  } }));
  assert.ok(request); const ack = readNativeQuestionConsumed(f.data, request); assert.ok(ack);
  const invalidId = randomUUID();
  await writeFile(join(f.data, "claude-questions", invalidId + ".consumed.json"),
    JSON.stringify({ ...ack, eventId: invalidId, toolUseId: invalidId, answers: { decision: "I will answer later" } }), { mode: 0o600 });
  f.advance(2000);
  assert.equal(pruneNativeQuestionFiles(f.data, f.now()), 1);
  assert.equal(readNativeQuestionConsumed(f.data, request), undefined);
  assert.ok((await readdir(join(f.data, "claude-questions"))).includes(invalidId + ".consumed.json"));
});

test("Linux process identity rejects exited zombies and changed users, despite a retained PID/start record", async t => {
  const f = await fixture(t), proc = join(f.root, "proc"), pid = 123;
  await mkdir(join(proc, String(pid)), { recursive: true });
  const fields = Array.from({ length: 20 }, () => "0"); fields[0] = "S"; fields[19] = "9876";
  const stat = join(proc, String(pid), "stat"); await writeFile(stat, `${pid} (node worker) ${fields.join(" ")}`);
  const uid = process.getuid?.() ?? 0;
  assert.equal(await claudeQuestionProcessIdentity(pid, { platform: "linux", procRoot: proc, uid }), "9876");
  assert.equal(await claudeQuestionProcessIdentity(pid, { platform: "linux", procRoot: proc, uid: uid + 1 }), undefined);
  for (const state of ["Z", "X", "x"]) { fields[0] = state; await writeFile(stat, `${pid} (node worker) ${fields.join(" ")}`);
    assert.equal(await claudeQuestionProcessIdentity(pid, { platform: "linux", procRoot: proc, uid }), undefined); }
});
