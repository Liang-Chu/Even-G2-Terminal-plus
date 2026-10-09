import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ClaudeObserver, type ClaudeObservation } from "../packages/connectors/claude-observer.js";
import { NativeHost } from "../packages/pi-runtime/native-host.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { connectorKey } from "../packages/connectors/identity.js";
import { sessionAgentCount } from "../packages/cockpit-state/selectors.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pilot-claude-observer-")), logs = join(root, "projects"), queue = join(root, "claude-events");
  await mkdir(logs); await mkdir(queue);
  let now = Date.now(), alive = true;
  const events: ClaudeObservation[] = [], host = new NativeHost({ cwd: root, directory: join(root, "native"),
    preferencesPath: join(root, "watch.json"), sessions: { root: join(root, "pi") }, alive: () => alive,
    launch: async () => assert.fail("Observing an ordinary terminal must not open a window") });
  const journal = new NotificationJournal(host.store);
  const options = { directory: queue, root: logs, now: () => now, alive: async () => alive };
  const observer = new ClaudeObserver(event => { events.push(structuredClone(event)); host.observeClaude(event); }, options);
  t.after(async () => { await observer.stop(); await host.stop(); journal.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  async function session() {
    const id = randomUUID(), path = join(logs, id + ".jsonl"), key = connectorKey("claude", id);
    await writeFile(path, JSON.stringify({ type: "user", sessionId: id, cwd: root, timestamp: new Date(now).toISOString(),
      message: { role: "user", content: "Readable saved title" } }) + "\n");
    async function emit(name: string, extra: any = {}) {
      const eventId = extra.eventId || randomUUID(), at = extra.at ?? ++now;
      const event = { version: 1, eventId, at, hook_event_name: name, session_id: id,
        transcript_path: path, cwd: root, owner: { pid: 1234, started: "5678" }, stopTrusted: true, ...extra };
      await writeFile(join(queue, `${at}-${eventId}.json`), JSON.stringify(event));
      return event;
    }
    return { id, path, key, emit };
  }
  return { root, logs, queue, host, journal, events, options, observer, session,
    setAlive: (value: boolean) => { alive = value; }, advance: () => { now++; } };
}

test("ordinary Claude sessions use official hooks, notify independently and remain read-only", async t => {
  const f = await fixture(t), a = await f.session(), b = await f.session();
  for (const [s, prompt] of [[a, "Fix login"], [b, "Review release"]] as const) {
    await s.emit("SessionStart"); await s.emit("UserPromptSubmit", { prompt, model: "claude-test" });
  }
  await f.observer.poll();
  assert.equal(f.host.store.state.monitoring?.running, 2);
  await a.emit("Stop", { last_assistant_message: "Fixed login", background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1); assert.equal(f.journal.list()[0].sessionKey, a.key);
  assert.equal(f.host.store.state.monitoring?.running, 1);
  await b.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 2);
  const runtime = f.host.getRuntime(a.key);
  assert.deepEqual(runtime.store.state.capabilities, { prompt: false, interrupt: false });
  assert.equal(runtime.store.state.session.tunnel, "claude");
  assert.equal(runtime.store.state.session.model, "claude-test");
  await assert.rejects(runtime.prompt("do work"), /original Claude/);
  await assert.rejects(runtime.interrupt(), /original Claude/);
  assert.equal(runtime.store.state.transcript.at(-1)?.text, "Fixed login");
});

test("official Claude input hooks create minimal notices and matching lifecycle resolves them", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await s.emit("PermissionRequest", { tool_name: "Bash", tool_use_id: "permission-tool",
    tool_input: { command: "private command" }, permission_suggestions: ["private option"] }); await f.observer.poll();
  let state = f.host.getRuntime(s.key).store.state;
  assert.equal(state.attention?.length, 1); assert.equal(state.attention?.[0].kind, "approval");
  assert.equal(f.journal.list().filter(event => event.kind === "attention").length, 1);
  assert.doesNotMatch(JSON.stringify(state.attention), /private command|private option/);
  await s.emit("PermissionRequest", { tool_name: "Bash", tool_use_id: "permission-tool" }); await f.observer.poll();
  assert.equal(f.journal.list().filter(event => event.kind === "attention").length, 1);
  await s.emit("PostToolUse", { tool_use_id: "permission-tool" }); await f.observer.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.attention?.length, 0);
  await s.emit("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "question-tool" }); await f.observer.poll();
  state = f.host.getRuntime(s.key).store.state;
  assert.equal(state.attention?.[0].kind, "question"); assert.equal(state.main.status, "waiting");
  assert.deepEqual(state.capabilities, { prompt: false, interrupt: false });
  f.setAlive(false); await f.observer.poll();
  assert.equal(f.journal.list().filter(event => event.kind === "attention-resolved").length, 1, "Disconnect retains the outstanding question");
  f.setAlive(true); await f.observer.poll();
  await s.emit("PostToolUseFailure", { tool_use_id: "question-tool" }); await f.observer.poll();
  assert.equal(f.journal.list().filter(event => event.kind === "attention-resolved").length, 2);
  await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().filter(event => !event.kind || event.kind === "completion").length, 1);
});

test("Claude pending input persists through restart without replay and child/generic waiting metadata stays quiet", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await s.emit("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "persist-question" }); await f.observer.poll();
  await f.observer.stop(); f.advance();
  const observations: ClaudeObservation[] = [], restarted = new ClaudeObserver(event => { observations.push(event); f.host.observeClaude(event); }, f.options);
  t.after(() => restarted.stop()); await restarted.poll();
  assert.equal(observations.at(-1)?.state.attention?.[0].baseline, true);
  assert.equal(f.journal.list().filter(event => event.kind === "attention").length, 1);
  await s.emit("PermissionRequest", { agent_id: "child", tool_use_id: "child-choice" }); await restarted.poll();
  assert.equal(f.journal.list().filter(event => event.kind === "attention").length, 1);
  await s.emit("PostToolUse", { tool_use_id: "persist-question" }); await restarted.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.attention?.length, 0);
  await s.emit("PreToolUse", { tool_name: "Bash", tool_use_id: "ordinary-shell" }); await restarted.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.attention?.length, 0);
});

test("ordinary Claude refreshes readable question history without changing lifecycle or enabling control", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit", { prompt: "New prompt not committed yet" }); await f.observer.poll();
  const runtime = f.host.getRuntime(s.key);
  assert.equal(runtime.store.state.main.status, "running");
  const question = { type: "assistant", sessionId: s.id, cwd: f.root, timestamp: new Date(Date.now() + 10).toISOString(),
    message: { role: "assistant", content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [{
      question: "Which format?", options: [{ label: "Summary" }, { label: "Full" }], multiSelect: false,
    }] } }] } };
  await writeFile(s.path, (await readFile(s.path, "utf8")) + JSON.stringify(question) + "\n");
  await f.observer.poll();
  assert.match(runtime.store.state.transcript.at(-1)!.text, /Which format\?\n1\. Summary\n2\. Full/);
  assert.equal(runtime.store.state.interactions?.length || 0, 0);
  assert.deepEqual(runtime.store.state.capabilities, { prompt: false, interrupt: false });
  assert.equal(runtime.store.state.main.status, "running"); assert.equal(f.journal.list().length, 0);
  const count = f.events.length; await f.observer.poll();
  assert.equal(f.events.length, count, "Unchanged transcript does not publish or rerender history");
});

test("completion waits for tracked children and authoritative background registries", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit", { prompt: "Work in parallel" });
  for (const id of ["one", "two", "three"]) await s.emit("SubagentStart", { agent_id: id });
  await f.observer.poll();
  assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "4");
  await s.emit("Stop", { background_tasks: [{ id: "shell", type: "shell", status: "running" }] });
  for (const id of ["one", "two", "three"]) await s.emit("SubagentStop", { agent_id: id });
  await f.observer.poll(); assert.equal(f.journal.list().length, 0);
  await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
});

test("malformed background registries and untrackable children never fabricate zero agents", async t => {
  const f = await fixture(t), bg = await f.session(), child = await f.session();
  await bg.emit("UserPromptSubmit"); await bg.emit("Stop", { background_tasks: "invalid" });
  await child.emit("UserPromptSubmit"); await child.emit("SubagentStart", { agent_id: "" });
  await child.emit("Stop", { background_tasks: [] });
  await f.observer.poll(); assert.equal(f.journal.list().length, 0);
  assert.equal(f.host.getRuntime(bg.key).store.state.main.status, "running");
  assert.match(f.host.getRuntime(child.key).store.state.commandStatus!, /incomplete/);
  await bg.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  assert.equal(f.journal.list()[0].sessionKey, bg.key);
});

test("custom Stop hooks preserve uncertain work until trusted main and child completion", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await s.emit("SubagentStart", { agent_id: "child" });
  await s.emit("Stop", { stopTrusted: false, last_assistant_message: "Provisional reply" });
  await s.emit("SubagentStop", { stopTrusted: false, agent_id: "child", background_tasks: [] });
  await f.observer.poll(); assert.equal(f.journal.list().length, 0);
  const state = f.host.getRuntime(s.key).store.state;
  assert.equal(state.main.status, "running"); assert.equal(state.subagents?.active, 1);
  assert.equal(sessionAgentCount(state, true), "?", "Unverified stop decisions cannot be an exact activity count");
  assert.match(state.commandStatus!, /stop hooks/);
  await s.emit("PreToolUse", { tool_use_id: "continued", tool_name: "Read" });
  await s.emit("SubagentStop", { agent_id: "child", background_tasks: [] });
  await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
});

test("an internal tool wake after a settled turn creates a distinct completion cycle", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  await s.emit("PreToolUse", { tool_name: "Read", tool_use_id: "wake" });
  await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 2);
  const turns = f.events.flatMap(event => event.completion ? [event.completion.turnId] : []);
  assert.equal(new Set(turns).size, 2);
});

test("disconnect, SessionEnd and manual unwatch are never completion or process control", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await f.observer.poll(); await f.host.setMonitored(s.key, false);
  f.setAlive(false); await f.observer.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.connected, false);
  assert.equal(f.host.store.state.monitoring?.watched, 0); assert.equal(f.journal.list().length, 0);
  f.setAlive(true); await f.observer.poll();
  await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  await s.emit("UserPromptSubmit"); await s.emit("SessionEnd"); await f.observer.poll();
  assert.equal(f.host.store.state.monitoring?.watched, 0, "later original-window prompts preserve explicit Unwatch");
  assert.equal(f.journal.list().length, 0);
});

test("old queue establishes a baseline and duplicate hook UUIDs cannot replay notifications", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit", { at: Date.now() - 10_000 });
  await s.emit("Stop", { at: Date.now() - 9000, background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  await s.emit("UserPromptSubmit"); const stop = await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  await writeFile(join(f.queue, `${stop.at}-${stop.eventId}.json`), JSON.stringify(stop)); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  const events: ClaudeObservation[] = [], restarted = new ClaudeObserver(event => events.push(event), f.options);
  await restarted.poll(); await restarted.stop();
  assert.equal(events.filter(event => event.completion).length, 0);
  assert.equal((await readdir(f.queue)).length, 0);
  assert.equal(JSON.parse(await readFile(join(f.root, "claude-monitor-state.json"), "utf8")).processed.length, 4);
});

test("restart while busy retains blockers until an explicit new trusted Stop", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await s.emit("SubagentStart", { agent_id: "work" }); await f.observer.poll();
  await f.observer.stop(); f.advance();
  const events: ClaudeObservation[] = [], restarted = new ClaudeObserver(event => { events.push(event); f.host.observeClaude(event); }, f.options);
  await restarted.poll(); assert.equal(events.filter(event => event.completion).length, 0);
  await s.emit("Stop", { background_tasks: [] }); await restarted.poll();
  assert.equal(f.journal.list().length, 0);
  await s.emit("SubagentStop", { agent_id: "work", background_tasks: [] }); await restarted.poll();
  assert.equal(f.journal.list().length, 1); await restarted.stop();
});

test("a first prompt hook waits for Claude's delayed transcript creation", async t => {
  const f = await fixture(t), s = await f.session(), original = await readFile(s.path);
  await rm(s.path); await s.emit("UserPromptSubmit"); await f.observer.poll();
  assert.equal((await readdir(f.queue)).length, 1);
  await writeFile(s.path, original); await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  assert.equal((await readdir(f.queue)).length, 0);
});

test("missing closed-session transcripts cannot starve trusted stops in unrelated sessions", async t => {
  const f = await fixture(t), closed = await f.session(), active = await f.session();
  await rm(closed.path);
  await closed.emit("SessionStart"); await closed.emit("SessionEnd");
  await active.emit("UserPromptSubmit"); await active.emit("SubagentStart", { agent_id: "work" });
  await active.emit("Stop", { background_tasks: [] }); await active.emit("SubagentStop", { agent_id: "work", background_tasks: [] });
  await f.observer.poll();
  assert.equal(f.journal.list().length, 1); assert.equal(f.journal.list()[0].sessionKey, active.key);
  assert.equal((await readdir(f.queue)).length, 0);
});

test("a delayed valid first transcript blocks only that session's completion", async t => {
  const f = await fixture(t), delayed = await f.session(), other = await f.session(), original = await readFile(delayed.path);
  await rm(delayed.path); await delayed.emit("UserPromptSubmit");
  await delayed.emit("Stop", { background_tasks: [] });
  await other.emit("UserPromptSubmit"); await other.emit("Stop", { background_tasks: [] });
  await f.observer.poll();
  assert.equal(f.journal.list().length, 1); assert.equal(f.journal.list()[0].sessionKey, other.key);
  assert.equal((await readdir(f.queue)).length, 2);
  await writeFile(delayed.path, original); await f.observer.poll();
  assert.equal(f.journal.list().length, 2); assert.equal(f.journal.list()[1].sessionKey, delayed.key);
});

test("retired missing first prompts drain without completion and persist their lifecycle gap", async t => {
  const f = await fixture(t), s = await f.session();
  await rm(s.path); f.setAlive(false);
  const prompt = await s.emit("UserPromptSubmit", { at: Date.now() - 10_000 });
  await f.observer.poll();
  assert.equal((await readdir(f.queue)).length, 0);
  assert.equal(f.events.filter(event => event.completion).length, 0);
  const saved = JSON.parse(await readFile(join(f.root, "claude-monitor-state.json"), "utf8"));
  assert.ok(saved.processed.includes(prompt.eventId));
  assert.ok(saved.missingEvents.includes(prompt.at));
  assert.equal(saved.sessions.length, 0, "An obsolete prompt does not register a disconnected session");
});

test("retired missing prompts preserve a known owner's uncertainty across restart", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await f.observer.poll();
  const original = await readFile(s.path);
  await rm(s.path); f.setAlive(false);
  await s.emit("UserPromptSubmit"); await f.observer.poll();
  assert.equal((await readdir(f.queue)).length, 0);
  assert.match(f.host.getRuntime(s.key).store.state.commandStatus!, /invalid or missing/);
  assert.equal(f.journal.list().length, 0);
  await f.observer.stop(); f.advance();
  const events: ClaudeObservation[] = [], restarted = new ClaudeObserver(event => events.push(event), f.options);
  t.after(() => restarted.stop());
  await writeFile(s.path, original); f.setAlive(true);
  await s.emit("Stop", { background_tasks: [], session_crons: [] }); await restarted.poll();
  assert.equal(events.filter(event => event.completion).length, 0);
  assert.ok(JSON.parse(await readFile(join(f.root, "claude-monitor-state.json"), "utf8")).sessions[0].unknownChildren);
});

test("a full queue of retired missing prompts frees capacity for a new live owner", async t => {
  const f = await fixture(t), retired = await f.session(), active = await f.session();
  await rm(retired.path); await f.observer.stop();
  const liveOwner = { pid: 4321, started: "8765" };
  const observer = new ClaudeObserver(event => { f.events.push(event); f.host.observeClaude(event); }, {
    ...f.options, alive: async owner => owner.pid === liveOwner.pid,
  });
  t.after(() => observer.stop());
  const at = Date.now() - 20_000;
  await Promise.all(Array.from({ length: 1024 }, async (_, index) => {
    const eventId = randomUUID(), eventAt = at + index;
    await writeFile(join(f.queue, `${eventAt}-${eventId}.json`), JSON.stringify({
      version: 1, eventId, at: eventAt, hook_event_name: "UserPromptSubmit", session_id: retired.id,
      transcript_path: retired.path, cwd: f.root, owner: { pid: 1234, started: "5678" },
    }));
  }));
  assert.equal((await readdir(f.queue)).length, 1024);
  await observer.poll();
  assert.equal((await readdir(f.queue)).length, 960);
  const { writeClaudeHookEvent } = await import(new URL("../apps/windows/src/claude-monitor-hook.mjs", import.meta.url).href);
  assert.equal(writeClaudeHookEvent(f.root, {
    version: 1, eventId: randomUUID(), at: Date.now(), hook_event_name: "UserPromptSubmit", session_id: active.id,
    transcript_path: active.path, cwd: f.root,
  }, liveOwner), true, "Draining obsolete records allows the official hook writer to publish again");
  for (let index = 0; index < 16; index++) await observer.poll();
  assert.equal((await readdir(f.queue)).length, 0);
  assert.equal(f.host.getRuntime(active.key).store.state.connected, true);
  assert.equal(f.host.getRuntime(active.key).store.state.main.status, "running");
  assert.equal(f.events.filter(event => event.completion).length, 0);
});

test("uncertain retirement probes keep a missing first prompt queued", async t => {
  const f = await fixture(t), s = await f.session();
  await rm(s.path); await s.emit("UserPromptSubmit"); await f.observer.stop();
  for (const alive of [async () => undefined as unknown as boolean, async () => { throw Object.assign(new Error("Probe denied"), { code: "EPERM" }); }]) {
    const observer = new ClaudeObserver(event => f.events.push(event), { ...f.options, alive });
    await observer.poll(); await observer.stop();
    assert.equal((await readdir(f.queue)).length, 1);
  }
  const observer = new ClaudeObserver(event => f.events.push(event), { ...f.options, alive: undefined });
  t.after(() => observer.stop());
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("Probe denied"), { code: "EPERM" }); });
  await observer.poll();
  assert.equal((await readdir(f.queue)).length, 1);
  assert.equal(f.events.filter(event => event.completion).length, 0);
});

test("a definitively absent process allows its missing first prompt to drain", async t => {
  const f = await fixture(t), s = await f.session();
  await rm(s.path); await s.emit("UserPromptSubmit"); await f.observer.stop();
  const observer = new ClaudeObserver(event => f.events.push(event), { ...f.options, alive: undefined });
  t.after(() => observer.stop());
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("Process absent"), { code: "ESRCH" }); });
  await observer.poll();
  assert.equal((await readdir(f.queue)).length, 0);
  assert.equal(f.events.filter(event => event.completion).length, 0);
});

test("late trusted child stops use child timestamps without regressing parent registries", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); const start = await s.emit("SubagentStart", { agent_id: "child" }); await f.observer.poll();
  await s.emit("Stop", { at: start.at + 10, background_tasks: [{ id: "shell", status: "running" }], session_crons: [{ id: "wake" }] });
  await f.observer.poll();
  await s.emit("SubagentStop", { at: start.at + 1, agent_id: "child", background_tasks: [], session_crons: [], model: "older-model" });
  await f.observer.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.subagents?.active, 0);
  assert.equal(f.journal.list().length, 0, "Late child metadata cannot clear current shell/cron blockers");
  assert.notEqual(f.host.getRuntime(s.key).store.state.session.model, "older-model");
  await s.emit("Stop", { at: start.at + 11, background_tasks: [], session_crons: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
});

test("an older child stop cannot stop a resumed child or replay a completed child start", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); const first = await s.emit("SubagentStart", { agent_id: "child" }); await f.observer.poll();
  await s.emit("SubagentStart", { at: first.at + 10, agent_id: "child" });
  await s.emit("Stop", { at: first.at + 11, background_tasks: [] }); await f.observer.poll();
  await s.emit("SubagentStop", { at: first.at + 1, agent_id: "child" }); await f.observer.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.subagents?.active, 1); assert.equal(f.journal.list().length, 0);
  await s.emit("SubagentStop", { at: first.at + 12, agent_id: "child" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  await s.emit("SubagentStart", { at: first.at + 10, agent_id: "child" }); await f.observer.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.subagents?.active, 0); assert.equal(f.journal.list().length, 1);
});

test("equal-time conflicting child lifecycles stay uncertain in both delivery orders until a newer trusted stop", async t => {
  for (const stopFirst of [false, true]) {
    const f = await fixture(t), s = await f.session();
    await s.emit("UserPromptSubmit"); const initial = await s.emit("SubagentStart", { agent_id: "child" }); await f.observer.poll();
    const start = () => s.emit("SubagentStart", { at: initial.at + 10, agent_id: "child" });
    const stop = () => s.emit("SubagentStop", { at: initial.at + 10, agent_id: "child" });
    await (stopFirst ? stop() : start()); await f.observer.poll();
    await (stopFirst ? start() : stop()); await f.observer.poll();
    await s.emit("Stop", { at: initial.at + 11, background_tasks: [] }); await f.observer.poll();
    assert.equal(f.journal.list().length, 0); assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "?");
    assert.equal(f.host.getRuntime(s.key).store.state.subagents?.active, 1);
    await stop(); await f.observer.poll();
    assert.equal(f.journal.list().length, 0, "An equal-time trusted callback cannot resolve ambiguous order");
    await s.emit("SubagentStop", { at: initial.at + 12, agent_id: "child", stopTrusted: false }); await f.observer.poll();
    assert.equal(f.journal.list().length, 0, "A later untrusted hook still retains the child blocker");
    await s.emit("Stop", { at: initial.at + 13, background_tasks: [] }); await f.observer.poll();
    await s.emit("SubagentStop", { at: initial.at + 14, agent_id: "child" }); await f.observer.poll();
    assert.equal(f.journal.list().length, 1); assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "0");
    assert.equal(f.host.getRuntime(s.key).store.state.commandStatus, undefined);
  }
});

test("a first child Start discovered in an equal-time conflict still supplies a resolvable start watermark", async t => {
  const f = await fixture(t), s = await f.session(), prompt = await s.emit("UserPromptSubmit");
  await s.emit("PreToolUse", { at: prompt.at + 13, tool_use_id: "parent", tool_name: "Read" }); await f.observer.poll();
  await s.emit("SubagentStop", { at: prompt.at + 10, agent_id: "new-child" }); await f.observer.poll();
  await s.emit("SubagentStart", { at: prompt.at + 10, agent_id: "new-child" }); await f.observer.poll();
  await s.emit("Stop", { at: prompt.at + 14, background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0); assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "?");
  await s.emit("SubagentStop", { at: prompt.at + 12, agent_id: "new-child" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1); assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "0");
  assert.equal(f.host.getRuntime(s.key).store.state.commandStatus, undefined);
});

test("a late child stop after SessionEnd cannot synthesize completion", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); const start = await s.emit("SubagentStart", { agent_id: "child" }); await f.observer.poll();
  await s.emit("Stop", { at: start.at + 10, background_tasks: [] });
  await s.emit("SessionEnd", { at: start.at + 11 }); await f.observer.poll();
  await s.emit("SubagentStop", { at: start.at + 1, agent_id: "child" }); await f.observer.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.connected, false); assert.equal(f.journal.list().length, 0);
});

test("late child acknowledgements cannot skip their own durable gap evidence", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); const start = await s.emit("SubagentStart", { agent_id: "child" }); await f.observer.poll();
  await s.emit("Stop", { at: start.at + 10, background_tasks: [] }); await f.observer.poll();
  await s.emit("SubagentStop", { at: start.at + 1, agent_id: "child", gapUnconfirmed: true }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0); assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "?");
  await s.emit("Stop", { at: start.at + 11, background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
});

test("trusted legacy child acknowledgements repair display counts without inventing completion", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit");
  const children = Array.from({ length: 98 }, (_, index) => "child-" + index);
  for (const agent_id of children) await s.emit("SubagentStart", { agent_id });
  await f.observer.poll(); await f.observer.poll();
  await f.observer.stop();
  const path = join(f.root, "claude-monitor-state.json"), saved = JSON.parse(await readFile(path, "utf8"));
  const row = saved.sessions.find((row: any) => row.id === s.id); delete row.childEvents;
  await writeFile(path, JSON.stringify(saved)); f.advance();
  const events: ClaudeObservation[] = [], restarted = new ClaudeObserver(event => { events.push(event); f.host.observeClaude(event); }, f.options);
  t.after(() => restarted.stop()); await restarted.poll();
  assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "?");
  for (const agent_id of children) await s.emit("SubagentStop", { at: row.lastAt - 1, agent_id, background_tasks: [] });
  await restarted.poll(); await restarted.poll();
  const state = f.host.getRuntime(s.key).store.state;
  assert.equal(state.subagents?.active, 0); assert.equal(state.main.status, "running");
  assert.equal(sessionAgentCount(state, true), "?"); assert.equal(events.filter(event => event.completion).length, 0);
  const repaired = JSON.parse(await readFile(path, "utf8")).sessions.find((row: any) => row.id === s.id);
  assert.equal(repaired.children.length, 98, "Legacy lifecycle uncertainty remains a completion guard");
  assert.equal(repaired.childEvents.length, 98);
  await s.emit("Stop", { at: row.lastAt + 1, stopTrusted: false, background_tasks: [] }); await restarted.poll();
  await s.emit("Stop", { at: row.lastAt + 2, background_tasks: undefined }); await restarted.poll();
  await s.emit("Stop", { at: row.lastAt + 3, background_tasks: "invalid" }); await restarted.poll();
  await s.emit("Stop", { at: row.lastAt + 4, owner: { pid: 999, started: "123" }, background_tasks: [] }); await restarted.poll();
  assert.equal(events.filter(event => event.completion).length, 0, "Untrusted, unknown-registry or other-owner boundaries cannot resolve legacy guards");
  await s.emit("SubagentStart", { at: row.lastAt + 5, agent_id: children[0] }); await restarted.poll();
  await s.emit("Stop", { at: row.lastAt + 6, background_tasks: [] }); await restarted.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.subagents?.active, 1);
  assert.equal(events.filter(event => event.completion).length, 0, "An acknowledged ID that restarts is a real running child again");
  const remaining = JSON.parse(await readFile(path, "utf8")).sessions.find((row: any) => row.id === s.id);
  assert.deepEqual(remaining.children, [children[0]], "Fresh safe boundary resolves only acknowledged legacy IDs");
  await s.emit("SubagentStart", { at: row.lastAt, agent_id: children[1] }); await restarted.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.subagents?.active, 1, "Reconciled legacy tombstones prevent a late start from resurrecting history");
  await s.emit("SubagentStop", { at: row.lastAt + 7, agent_id: children[0] }); await restarted.poll();
  assert.equal(events.filter(event => event.completion).length, 1);
  assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "0");
});

test("missing event guards survive legacy acknowledgements and a fresh trusted parent Stop", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await s.emit("SubagentStart", { agent_id: "legacy" }); await f.observer.poll();
  await f.observer.stop();
  const path = join(f.root, "claude-monitor-state.json"), saved = JSON.parse(await readFile(path, "utf8"));
  const row = saved.sessions.find((row: any) => row.id === s.id); delete row.childEvents;
  await writeFile(path, JSON.stringify(saved)); f.advance();
  const events: ClaudeObservation[] = [], restarted = new ClaudeObserver(event => { events.push(event); f.host.observeClaude(event); }, f.options);
  t.after(() => restarted.stop()); await restarted.poll();
  await s.emit("SubagentStop", { at: row.lastAt - 1, agent_id: "legacy" }); await restarted.poll();
  await s.emit("Stop", { background_tasks: [], gapUnconfirmed: true }); await restarted.poll();
  assert.equal(events.filter(event => event.completion).length, 0);
  assert.equal(sessionAgentCount(f.host.getRuntime(s.key).store.state, true), "?");
  const kept = JSON.parse(await readFile(path, "utf8")).sessions.find((row: any) => row.id === s.id);
  assert.deepEqual(kept.children, ["legacy"]); assert.equal(kept.unknownChildren, true);
});

test("recurring, missing and malformed cron registries keep scheduled sessions unsettled", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit");
  await s.emit("Stop", { background_tasks: [], session_crons: [{ id: "wake", recurring: true }] });
  await f.observer.poll(); assert.equal(f.journal.list().length, 0);
  await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0, "missing registry preserves known scheduled work");
  await s.emit("Stop", { session_crons: "bad" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  await s.emit("Stop", { background_tasks: [], session_crons: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
});

test("permanent invalid queue entries cannot starve later hooks or falsely complete a new run in the same batch", async t => {
  const f = await fixture(t), safe = await f.session();
  for (let index = 0; index < 64; index++)
    await writeFile(join(f.queue, `${Date.now() - 10000 + index}-${randomUUID()}.json`), "malformed");
  await safe.emit("UserPromptSubmit"); await safe.emit("Stop", { background_tasks: [] });
  await f.observer.poll(); await f.observer.poll();
  assert.equal(f.journal.list().length, 1, "older invalid files do not starve a later complete turn");
  const uncertain = await f.session(); await uncertain.emit("UserPromptSubmit");
  const bad = await uncertain.emit("SubagentStart", { agent_id: "lost" });
  await writeFile(join(f.queue, `${bad.at}-${bad.eventId}.json`), "malformed child start");
  await uncertain.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1, "same-batch missing child start blocks completion");
  assert.match(f.host.getRuntime(uncertain.key).store.state.commandStatus!, /invalid or missing/);
  assert.equal((await readdir(f.queue)).length, 0);
});

test("a durable dropped-hook watermark survives restart and blocks a later accepted Stop", async t => {
  const f = await fixture(t), s = await f.session();
  const start = await s.emit("UserPromptSubmit"); await f.observer.poll();
  await writeFile(join(f.root, "claude-monitor-gap.json"), JSON.stringify({ version: 1, through: start.at + 1 }));
  f.advance(); await s.emit("Stop", { background_tasks: [], session_crons: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  await f.observer.stop(); f.advance();
  const events: ClaudeObservation[] = [], restarted = new ClaudeObserver(event => events.push(event), f.options);
  await restarted.poll(); await s.emit("Stop", { background_tasks: [], session_crons: [] }); await restarted.poll();
  assert.equal(events.filter(event => event.completion).length, 0);
  const newer = await f.session(); await newer.emit("UserPromptSubmit"); await newer.emit("Stop", { background_tasks: [], session_crons: [] });
  await restarted.poll(); assert.equal(events.filter(event => event.completion).length, 1); await restarted.stop();
});

test("owner discovery failures and other rejected lifecycle metadata cannot lose a child start silently", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit");
  await s.emit("SubagentStart", { agent_id: "unverified-owner", owner: undefined });
  await s.emit("Stop", { background_tasks: [], session_crons: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  assert.match(f.host.getRuntime(s.key).store.state.commandStatus!, /invalid or missing/);
});

test("subagent-scoped tool and Stop hooks cannot finish or restart the parent's main agent", async t => {
  const f = await fixture(t), s = await f.session();
  await s.emit("UserPromptSubmit"); await s.emit("SubagentStart", { agent_id: "child" });
  await s.emit("Stop", { background_tasks: [] }); await f.observer.poll();
  await s.emit("PreToolUse", { agent_id: "child", tool_use_id: "child-tool" });
  await s.emit("Stop", { agent_id: "child", background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  await s.emit("SubagentStop", { agent_id: "child", background_tasks: [] }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
});
