import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, writeFile, rm, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CodexObserver, type CodexObservation } from "../packages/connectors/codex-observer.js";
import { connectorKey } from "../packages/connectors/identity.js";
import { NativeHost } from "../packages/pi-runtime/native-host.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { sessionAgentCount } from "../packages/cockpit-state/selectors.js";
import { writeLocalJson, readLocalJson, type NativeSnapshot } from "../packages/pi-runtime/native-protocol.js";
import { initialState } from "../packages/cockpit-state/types.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pilot-codex-observer-"));
  const logs = join(root, "sessions"), directory = join(root, "native"), events: CodexObservation[] = [];
  await mkdir(logs); await mkdir(directory);
  let alive = true;
  const host = new NativeHost({ cwd: root, directory, preferencesPath: join(root, "watch.json"), sessions: { root: join(root, "pi") },
    alive: () => alive, launch: async () => assert.fail("Observing must never open a duplicate window") });
  const journal = new NotificationJournal(host.store);
  const since = Date.now() - 1000;
  const observer = new CodexObserver(event => { events.push(structuredClone(event)); host.observeCodex(event); }, { root: logs, now: since });
  t.after(async () => { await observer.stop(); await host.stop(); journal.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const row = (payload: any, type = "event_msg", at = since + 100) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + "\n";
  async function session(source: string | object = "cli", parent?: string) {
    const id = randomUUID(), path = join(logs, `rollout-${id}.jsonl`), key = connectorKey("codex", id);
    await writeFile(path, row({ id, cwd: root, source, parent_thread_id: parent }, "session_meta"));
    return { id, path, key, append: async (payload: any, type?: string, at?: number) => appendFile(path, row(payload, type, at)) };
  }
  return { root, logs, directory, host, observer, journal, events, since, row, session, setAlive: (value: boolean) => { alive = value; } };
}

test("ordinary CLI and local desktop sessions notify independently, exactly once, with readable names", async t => {
  const f = await fixture(t), cli = await f.session(), app = await f.session("vscode");
  for (const [s, turn, name] of [[cli, "a", "Fix login"], [app, "b", "Review change"]] as const) {
    await s.append({ type: "task_started", turn_id: turn });
    await s.append({ model: "gpt-test" }, "turn_context");
    await s.append({ type: "message", role: "user", content: [{ type: "input_text", text: name }] }, "response_item");
  }
  await f.observer.poll(true);
  assert.equal(f.host.store.state.monitoring?.running, 2);
  await cli.append({ type: "task_complete", turn_id: "a" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  assert.equal(f.journal.list()[0].session, "Fix login");
  assert.equal(f.host.store.state.monitoring?.running, 1);
  await cli.append({ type: "task_complete", turn_id: "a" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  await app.append({ type: "task_complete", turn_id: "b" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 2);
  await f.host.resumeSession(app.key);
  assert.equal(f.host.store.state.session.model, "gpt-test");
  assert.equal(f.host.store.state.capabilities?.prompt, false);
});

test("very short tasks discovered after completion notify; old history and backend restart never replay", async t => {
  const f = await fixture(t), fresh = await f.session(), old = await f.session();
  for (const [s, at] of [[fresh, f.since + 100], [old, f.since - 1000]] as const) {
    await s.append({ type: "task_started", turn_id: s.id }, undefined, at);
    await s.append({ type: "task_complete", turn_id: s.id }, undefined, at);
  }
  await f.observer.poll(true);
  assert.deepEqual(f.journal.list().map(e => e.sessionKey), [fresh.key]);
  const replay: CodexObservation[] = [];
  const restarted = new CodexObserver(e => replay.push(e), { root: f.logs });
  await restarted.poll(true); await restarted.stop();
  assert.equal(replay.filter(e => e.completion).length, 0);
});

test("two short turns that settle between discovery passes are both retained", async t => {
  const f = await fixture(t), s = await f.session();
  for (const id of ["first", "second"]) {
    await s.append({ type: "task_started", turn_id: id });
    await s.append({ type: "task_complete", turn_id: id });
  }
  await f.observer.poll(true);
  assert.equal(f.journal.list().length, 2);
  await f.observer.poll(); assert.equal(f.journal.list().length, 2);
});

test("root completion waits for real subagent completion; children never become independent sessions", async t => {
  const f = await fixture(t), main = await f.session("vscode"), child = await f.session({ subagent: {} }, main.id);
  await main.append({ type: "task_started", turn_id: "root" });
  await child.append({ type: "task_started", turn_id: "child" });
  await f.observer.poll(true);
  assert.equal(f.host.store.state.monitoring?.sessions.length, 1);
  assert.equal(sessionAgentCount(f.host.getRuntime(main.key).store.state, true), "2");
  await main.append({ type: "task_complete", turn_id: "root" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  assert.equal(sessionAgentCount(f.host.getRuntime(main.key).store.state, true), "1");
  await child.append({ type: "task_complete", turn_id: "child" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  assert.equal(sessionAgentCount(f.host.getRuntime(main.key).store.state, true), "0");
});

test("unwatch and unreadable logs never kill, finish or rewatch a running session", async t => {
  const f = await fixture(t), s = await f.session();
  await s.append({ type: "task_started", turn_id: "one" }); await f.observer.poll(true);
  await f.host.setMonitored(s.key, false);
  const contents = await readFile(s.path);
  await rm(s.path); await f.observer.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.connected, false);
  assert.equal(f.host.store.state.monitoring?.watched, 0);
  assert.equal(f.journal.list().length, 0);
  await writeFile(s.path, contents); await f.observer.poll();
  assert.equal(f.host.store.state.monitoring?.watched, 0);
  await s.append({ type: "task_complete", turn_id: "one" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  await s.append({ type: "task_started", turn_id: "two" }); await f.observer.poll();
  assert.equal(f.host.store.state.monitoring?.watched, 0, "later original-window prompts preserve explicit Unwatch");
  await s.append({ type: "task_complete", turn_id: "two" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  await f.host.resumeSession(s.key);
  assert.equal(f.host.store.state.monitoring?.watched, 1, "explicit selection can re-enable Watch");
});

test("a child created between discovery passes prevents an early parent notification", async t => {
  const f = await fixture(t), main = await f.session();
  await main.append({ type: "task_started", turn_id: "root" }); await f.observer.poll(true);
  const child = await f.session({ subagent: {} }, main.id);
  await child.append({ type: "task_started", turn_id: "child" });
  await main.append({ type: "task_complete", turn_id: "root" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  assert.equal(sessionAgentCount(f.host.getRuntime(main.key).store.state, true), "1");
  await child.append({ type: "task_complete", turn_id: "child" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
});

test("desktop child rollouts keep their first identity despite copied parent metadata and freshly stamped history", async t => {
  const f = await fixture(t), main = await f.session("vscode");
  await main.append({ type: "task_started", turn_id: "current-parent" });
  await f.observer.poll(true);
  const child = await f.session({ subagent: { thread_spawn: { parent_thread_id: main.id } } }, main.id);
  // Codex Desktop clones history into a child with fresh row timestamps. Its
  // own first metadata is followed by the parent's copied session metadata.
  await child.append({ id: main.id, cwd: f.root, source: "vscode" }, "session_meta");
  await child.append({ type: "task_started", turn_id: "old-parent" });
  await child.append({ type: "task_complete", turn_id: "old-parent" });
  await child.append({ type: "task_started", turn_id: "current-parent" });
  await child.append({ type: "task_started", turn_id: "child-work" });
  await f.observer.poll(true);
  assert.equal(f.host.store.state.monitoring?.sessions.length, 1);
  assert.equal(sessionAgentCount(f.host.getRuntime(main.key).store.state, true), "2");
  assert.equal(f.journal.list().length, 0, "cloned history is never a parent completion");
  await child.append({ type: "task_complete", turn_id: "child-work" });
  await f.observer.poll();
  assert.equal(sessionAgentCount(f.host.getRuntime(main.key).store.state, true), "1");
  assert.equal(f.journal.list().length, 0, "finishing a child does not finish its active parent");
  await main.append({ type: "task_complete", turn_id: "current-parent" });
  await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  assert.equal(f.journal.list()[0].sessionKey, main.key);
});

test("a user fork retains its own session identity when copied history includes another session_meta", async t => {
  const f = await fixture(t), original = await f.session("vscode"), fork = await f.session("vscode");
  await original.append({ type: "task_started", turn_id: "original-active" });
  await fork.append({ id: original.id, cwd: f.root, source: "vscode" }, "session_meta");
  await fork.append({ type: "task_started", turn_id: "fork-active" });
  await f.observer.poll(true);
  assert.equal(f.host.store.state.monitoring?.sessions.length, 2);
  await fork.append({ type: "task_complete", turn_id: "fork-active" });
  await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
  assert.equal(f.journal.list()[0].sessionKey, fork.key);
  assert.equal(f.host.getRuntime(original.key).store.state.main.status, "running");
});

test("old idle observation buffers are released while watches and unresolved work remain", async t => {
  const f = await fixture(t), idle = await f.session(), busy = await f.session();
  for (const s of [idle, busy]) await s.append({ type: "task_started", turn_id: s.id });
  await idle.append({ type: "task_complete", turn_id: idle.id }); await f.observer.poll(true);
  const old = new Date(Date.now() - 86_400_001);
  for (const s of [idle, busy]) await utimes(s.path, old, old);
  await f.observer.poll(true);
  assert.equal(f.events.filter(e => e.retired).length, 1);
  assert.equal(f.host.store.state.monitoring?.sessions.find(s => s.key === idle.key)?.monitored, true);
  assert.equal(f.host.getRuntime(busy.key).store.state.main.status, "running");
  assert.equal(f.journal.list().length, 1);
});

test("partial UTF-8, malformed lines, reasoning and unrelated turn completion stay safe", async t => {
  const f = await fixture(t), s = await f.session();
  await s.append({ type: "task_started", turn_id: "run" }); await f.observer.poll(true);
  const message = Buffer.from(f.row({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "完成" }] }, "response_item"));
  const split = message.indexOf(Buffer.from("完成")) + 1;
  await appendFile(s.path, message.subarray(0, split)); await f.observer.poll();
  await appendFile(s.path, message.subarray(split));
  await s.append({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "private reasoning" }] }, "response_item");
  await appendFile(s.path, "not json\n");
  await s.append({ type: "task_complete", turn_id: "other" }); await f.observer.poll();
  const state = f.host.getRuntime(s.key).store.state;
  assert.equal(state.currentAssistantText, "完成"); assert.equal(state.main.status, "running");
  assert.equal(JSON.stringify(state).includes("private reasoning"), false);
  assert.equal(f.journal.list().length, 0);
});

test("existing connector retains prompt delivery and sole ownership of completion notifications", async t => {
  const f = await fixture(t), s = await f.session();
  const state = initialState(f.root);
  state.session = { key: s.key, id: s.id, tunnel: "codex", cwd: f.root }; state.connected = true;
  const native: NativeSnapshot = { version: 1, pid: 12345, instance: randomUUID(), at: Date.now(), updatedAt: Date.now(), runId: 1, completions: [], state };
  writeLocalJson(join(f.directory, "12345.json"), native); f.host.scan();
  await s.append({ type: "task_started", turn_id: "native" }); await f.observer.poll(true);
  assert.notEqual(f.host.getRuntime(s.key).store.state.capabilities?.prompt, false);
  const promise = f.host.getRuntime(s.key).prompt("Continue");
  const command = readLocalJson(join(f.directory, `${native.instance}.command.json`));
  writeLocalJson(join(f.directory, `${native.instance}.reply.json`), { id: command.id }); await promise;
  assert.equal(command.text, "Continue");
  await s.append({ type: "task_complete", turn_id: "native" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 0);
  native.completions.push({ id: 1, at: Date.now(), outcome: "completed" });
  writeLocalJson(join(f.directory, "12345.json"), native); f.host.scan();
  assert.equal(f.journal.list().length, 1);
  f.setAlive(false);
  await s.append({ type: "task_started", turn_id: "ordinary-resume" }, undefined, native.at + 10);
  await f.observer.poll();
  assert.equal(f.host.getRuntime(s.key).store.state.capabilities?.prompt, false, "later bare CLI resume may use observation");
  await s.append({ type: "task_complete", turn_id: "ordinary-resume" }, undefined, native.at + 20);
  await f.observer.poll();
  assert.equal(f.journal.list().length, 2);
});

test("large active rollouts retain their start/model before the bounded tail and exclude oversized output", async t => {
  const f = await fixture(t), s = await f.session();
  await s.append({ type: "task_started", turn_id: "long" }, undefined, f.since - 10_000);
  await s.append({ model: "long-running-model" }, "turn_context", f.since - 10_000);
  await s.append({ type: "reasoning", text: "x".repeat(3 * 1024 * 1024) }, "response_item");
  await f.observer.poll(true);
  assert.equal(f.host.getRuntime(s.key).store.state.main.status, "running");
  assert.equal(f.host.getRuntime(s.key).store.state.session.model, "long-running-model");
  assert.equal(f.host.getRuntime(s.key).store.state.transcript.length, 0);
  assert.equal(f.journal.list().length, 0);
  await s.append({ type: "task_complete", turn_id: "long" }); await f.observer.poll();
  assert.equal(f.journal.list().length, 1);
});

test("Codex's saved title is used for the notification and G2 view suppression still applies", async t => {
  const f = await fixture(t), s = await f.session("vscode");
  await writeFile(join(f.root, "session_index.jsonl"), JSON.stringify({ id: s.id, thread_name: "Named desktop work", updated_at: "now" }) + "\n");
  await s.append({ type: "task_started", turn_id: "viewed" }); await f.observer.poll(true);
  f.journal.g2.update({ clientId: "a".repeat(32), sequence: 1, sessionKey: s.key });
  await s.append({ type: "task_complete", turn_id: "viewed" }); await f.observer.poll();
  assert.equal(f.journal.list()[0].session, "Named desktop work");
  assert.equal(f.journal.list()[0].viewedOnG2, true);
});
