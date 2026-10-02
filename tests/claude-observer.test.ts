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
