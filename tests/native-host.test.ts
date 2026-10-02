import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { NativeHost } from "../packages/pi-runtime/native-host.js";
import { writeLocalJson, readLocalJson, type NativeSnapshot } from "../packages/pi-runtime/native-protocol.js";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { sessionKey } from "../packages/pi-runtime/sessions.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import monitor from "../apps/windows/src/pi-extension.js";
import { sessionAgentCount } from "../packages/cockpit-state/selectors.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { savedEntries } from "./fixtures/saved-sessions.js";
import { runSessionCommand } from "../apps/linux/src/session-cli.js";

function nativeSnapshot(host: NativeHost, key: string) {
  const runtime = host.getRuntime(key);
  assert.ok("snapshot" in runtime);
  return runtime.snapshot;
}

async function fixture(t: any, alive: (pid: number) => boolean = () => true) {
  const root = await mkdtemp(join(tmpdir(), "pilot-native-")), sessions = join(root, "sessions"), directory = join(root, "native");
  await mkdir(sessions); await mkdir(directory);
  const paths = [join(sessions, "first.jsonl"), join(sessions, "second.jsonl")];
  for (let i = 0; i < paths.length; i++) {
    const entries = savedEntries(root); entries[0].id = `source-${i}`;
    await writeFile(paths[i], entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    await utimes(paths[i], new Date(1000 + i * 1000), new Date(1000 + i * 1000));
  }
  const launched: string[] = [];
  const host = new NativeHost({ cwd: root, directory, preferencesPath: join(root, "monitoring.json"), sessions: { root: sessions },
    launch: async path => { launched.push(path); }, alive });
  const journal = new NotificationJournal(host.store);
  const make = (i: number, running = false) => {
    const store = new CockpitStore(root);
    store.dispatch({ type: "session.updated", session: { key: sessionKey(paths[i]), id: `source-${i}`, cwd: root } });
    store.dispatch({ type: "runtime.connected" }); if (running) store.dispatch({ type: "agent.started" });
    const snapshot: NativeSnapshot = { version: 1, instance: randomUUID(), pid: 1000 + i, at: Date.now(), updatedAt: 1000 + i * 1000,
      sessionFile: paths[i], runId: running ? 1 : 0, completions: [], state: store.state };
    const publish = () => { snapshot.state = store.state; writeLocalJson(join(directory, `${snapshot.pid}.json`), snapshot); host.scan(); };
    publish(); return { snapshot, store, publish };
  };
  t.after(async () => { await host.stop(); journal.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, sessions, directory, paths, launched, host, journal, make };
}

test("already-open native sessions are selected without a launch or fork; later original messages synchronize", async t => {
  const f = await fixture(t), original = await readFile(f.paths[0], "utf8"), window = f.make(0);
  await f.host.resumeSession(window.store.state.session.key!);
  assert.equal(f.launched.length, 0); assert.equal(f.host.store.state.session.key, sessionKey(f.paths[0]));
  window.store.dispatch({ type: "user.message", text: "From the original terminal" }); window.publish();
  assert.equal(f.host.store.state.transcript.at(-1)?.text, "From the original terminal");
  assert.equal(await readFile(f.paths[0], "utf8"), original);
  await f.host.setMonitored(sessionKey(f.paths[0]), false);
  assert.equal(f.host.getRuntime(sessionKey(f.paths[0])).store.state.connected, true);
  assert.equal(f.host.store.state.monitoring?.watched, 0);
  await f.host.stop(); assert.equal(f.host.getRuntime(sessionKey(f.paths[0])).store.state.connected, true);
});

test("closed sessions open the original file once and monitor it without copying; recent updates sort globally", async t => {
  const f = await fixture(t), key = sessionKey(f.paths[0]);
  const before = await readFile(f.paths[0], "utf8");
  await f.host.resumeSession(key); await f.host.resumeSession(key);
  assert.deepEqual(f.launched, [f.paths[0]]);
  assert.equal(await readFile(f.paths[0], "utf8"), before);
  assert.equal((await f.host.listSessions()).sessions[0].key, sessionKey(f.paths[1]));
  const first = f.make(0); first.snapshot.updatedAt = 3000; first.publish();
  assert.equal((await f.host.listSessions()).sessions[0].key, key);
  const repeated = await f.host.listSessions(); await delay(20);
  assert.equal((await f.host.listSessions()).sessions[0].updatedAt, repeated.sessions[0].updatedAt);
});

test("duplicate Pi windows follow conversation activity, never alternate on idle heartbeats", async t => {
  const f = await fixture(t), old = f.make(0), key = sessionKey(f.paths[0]);
  await f.host.resumeSession(key);
  const activeStore = new CockpitStore(f.root);
  activeStore.dispatch({ type: "session.updated", session: { ...old.store.state.session } });
  activeStore.dispatch({ type: "runtime.connected" });
  activeStore.dispatch({ type: "agent.started" });
  activeStore.dispatch({ type: "assistant.delta", text: "Current desktop output" });
  const active: NativeSnapshot = { ...old.snapshot, pid: 3000, instance: randomUUID(), runId: 2,
    updatedAt: old.snapshot.updatedAt + 100, state: activeStore.state, completions: [] };
  writeLocalJson(join(f.directory, "3000.json"), active); f.host.scan();
  for (let i = 1; i <= 5; i++) {
    old.snapshot.at = active.at + i * 10; old.publish();
    assert.equal(nativeSnapshot(f.host, key).instance, active.instance);
    assert.equal(sessionAgentCount(f.host.store.state, true), "1");
    assert.equal(f.host.store.state.currentAssistantText, "Current desktop output");
  }
  activeStore.dispatch({ type: "agent.settled" }); active.state = activeStore.state;
  active.updatedAt++; active.completions.push({ id: 2, at: Date.now(), outcome: "completed" });
  writeLocalJson(join(f.directory, "3000.json"), active); f.host.scan(); old.publish();
  assert.equal(f.journal.list().length, 1, "completion is not lost or replayed when idle windows keep reporting");
  assert.equal(sessionAgentCount(f.host.store.state, true), "0");
  const sending = f.host.getRuntime(key).prompt("Next task");
  const commandPath = join(f.directory, `${active.instance}.command.json`);
  const command = readLocalJson(commandPath);
  assert.equal(command.text, "Next task");
  assert.equal((await readdir(f.directory)).includes(`${old.snapshot.instance}.command.json`), false);
  writeLocalJson(join(f.directory, `${active.instance}.reply.json`), { id: command.id }); await sending;
  // Typing in the original window is a real takeover, unlike its heartbeat.
  old.store.dispatch({ type: "agent.started" }); old.snapshot.updatedAt = active.updatedAt + 1; old.snapshot.runId = 3; old.publish();
  assert.equal(nativeSnapshot(f.host, key).instance, old.snapshot.instance);
  assert.equal(f.launched.length, 0);
});

test("startup chooses the latest duplicate once, regardless of directory order", async t => {
  const f = await fixture(t), old = f.make(0), key = sessionKey(f.paths[0]);
  const active = { ...old.snapshot, pid: 3000, instance: randomUUID(), updatedAt: old.snapshot.updatedAt + 10,
    state: { ...old.store.state, main: { status: "running" as const }, currentAssistantText: "Latest" } };
  writeLocalJson(join(f.directory, "3000.json"), active);
  const restored = new NativeHost({ cwd: f.root, directory: f.directory, preferencesPath: join(f.root, "monitoring.json"),
    sessions: { root: f.sessions }, launch: async () => { assert.fail("No terminal should open"); }, alive: () => true });
  t.after(() => restored.stop()); restored.scan();
  assert.equal(nativeSnapshot(restored, key).instance, active.instance);
  active.at = Date.now() - 7000; writeLocalJson(join(f.directory, "3000.json"), active);
  old.snapshot.at = Date.now(); old.publish(); restored.scan();
  assert.equal(restored.getRuntime(key).store.state.connected, false, "a lost heartbeat must not restore another window's stale idle state");
  assert.equal(restored.getRuntime(key).store.state.currentAssistantText, "Latest");
  assert.equal(restored.store.state.monitoring?.watched, 1);
});

test("desktop defaults use a rolling 24 hours, keep closed terminals closed, and apply once per manager opening", async t => {
  const f = await fixture(t), now = Date.now(), day = 86_400_000;
  const recentKey = sessionKey(f.paths[0]), oldKey = sessionKey(f.paths[1]);
  await utimes(f.paths[0], new Date(now - day), new Date(now - day));
  await utimes(f.paths[1], new Date(now - day - 1000), new Date(now - day - 1000));
  await f.host.setMonitored(oldKey, true);
  const opening = randomUUID();
  await f.host.applyDesktopDefaults(opening, now);
  let rows = (await f.host.listSessions()).sessions;
  assert.equal(rows.find(s => s.key === recentKey)?.monitored, true);
  assert.equal(rows.find(s => s.key === oldKey)?.monitored, false);
  assert.equal(f.host.store.state.session.key, recentKey);
  assert.equal(f.host.store.state.connected, false);
  assert.equal(f.launched.length, 0);
  assert.equal(f.journal.list().length, 0);
  await f.host.setMonitored(recentKey, false);
  await f.host.applyDesktopDefaults(opening, now);
  assert.equal(f.host.store.state.monitoring?.watched, 0, "retry does not override manual unwatch");
  const restored = new NativeHost({ cwd: f.root, directory: f.directory, preferencesPath: join(f.root, "monitoring.json"),
    sessions: { root: f.sessions }, launch: async () => { assert.fail("Default watch must not open a terminal"); } });
  t.after(() => restored.stop());
  await restored.start(); await restored.applyDesktopDefaults(opening, now);
  assert.equal(restored.store.state.monitoring?.watched, 0, "same request after backend restart stays idempotent");
  await restored.applyDesktopDefaults(randomUUID(), now);
  assert.equal(restored.store.state.monitoring?.watched, 1, "next explicit desktop open reapplies the recent default");
  await restored.applyDesktopDefaults(randomUUID(), now + day + 1);
  assert.equal(restored.store.state.monitoring?.watched, 0, "next day's cutoff excludes old sessions");
});

test("default watch uses activity time instead of heartbeats and never interrupts an old running terminal", async t => {
  const f = await fixture(t), window = f.make(0, true), key = sessionKey(f.paths[0]);
  const original = await readFile(f.paths[0], "utf8");
  assert.equal(f.host.store.state.monitoring?.watched, 1);
  await f.host.applyDesktopDefaults(randomUUID());
  assert.equal(f.host.store.state.monitoring?.watched, 0);
  assert.equal(f.host.getRuntime(key).store.state.main.status, "running");
  assert.equal(f.host.getRuntime(key).store.state.connected, true);
  window.snapshot.at = Date.now(); window.publish();
  assert.equal(f.host.store.state.monitoring?.watched, 0, "heartbeat is not a recent conversation update");
  assert.equal(f.launched.length, 0);
  assert.equal(f.journal.list().length, 0);
  assert.equal(await readFile(f.paths[0], "utf8"), original);
  await f.host.setMonitored(sessionKey(f.paths[1]), true);
  assert.equal(f.launched.length, 0, "checking Watch alone does not launch a closed session");
  await f.host.resumeSession(sessionKey(f.paths[1]));
  assert.deepEqual(f.launched, [f.paths[1]], "selecting the closed session opens its original terminal");
});

test("desktop API scopes defaults and unwatch leaves a running native process alive across updates and completion", async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => process.stdout.write('working\\n'), 30)"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
  await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
  const window = f.make(0, true), key = sessionKey(f.paths[0]);
  window.snapshot.pid = child.pid!; window.snapshot.updatedAt = Date.now(); window.publish();
  const bridge = createBridgeServer(f.host, f.journal, { host: f.host, token: "desktop-control", notificationToken: "glance-only" });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done)); t.after(() => bridge.close());
  const origin = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, token = "desktop-control") => fetch(origin + path, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const opening = { openId: randomUUID() };
  assert.equal((await post("/api/desktop/open", opening, "glance-only")).status, 403);
  assert.equal((await post("/api/desktop/open", { openId: "bad" })).status, 400);
  assert.equal((await post("/api/desktop/open", opening)).status, 200);
  assert.equal((await post(`/api/runtime/${key}/monitor`, { monitored: false })).status, 200);
  assert.doesNotThrow(() => process.kill(child.pid!, 0));
  assert.equal(f.host.getRuntime(key).store.state.main.status, "running");
  assert.equal(f.host.getRuntime(key).store.state.connected, true);
  assert.equal(f.host.store.state.monitoring?.watched, 0);
  window.store.dispatch({ type: "assistant.delta", text: "Still working after unwatch" }); window.snapshot.updatedAt = Date.now(); window.publish();
  await post("/api/desktop/open", opening);
  assert.equal(f.host.store.state.monitoring?.watched, 0, "activity in the same run does not undo unwatch");
  window.store.dispatch({ type: "agent.settled" }); window.snapshot.completions.push({ id: 1, at: Date.now(), outcome: "completed" }); window.publish();
  assert.equal(f.journal.list().length, 0, "unwatched completion does not notify");
  assert.equal((await readdir(f.directory)).some(name => name.endsWith(".command.json")), false, "unwatch sends no terminal command");
  assert.doesNotThrow(() => process.kill(child.pid!, 0));
  await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
  window.snapshot.at = Date.now() - 7000; window.publish(); window.snapshot.at = Date.now(); window.publish();
  assert.equal(f.host.store.state.monitoring?.watched, 0, "disconnect/reconnect preserves explicit unwatch");
  window.snapshot.runId++;
  window.store.dispatch({ type: "agent.started" }); window.publish();
  window.store.dispatch({ type: "agent.settled" });
  window.snapshot.completions.push({ id: window.snapshot.runId, at: Date.now(), outcome: "completed" }); window.publish();
  assert.equal(f.host.store.state.monitoring?.watched, 0, "later native turns preserve explicit unwatch");
  assert.equal(f.journal.list().length, 0);
  assert.doesNotThrow(() => process.kill(child.pid!, 0));
});

test("backend shutdown and restart preserve a working native process and watch membership", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => process.stdout.write('working\\n'), 30)"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
  await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
  const window = f.make(0, true), key = sessionKey(f.paths[0]);
  await rm(join(f.directory, `${window.snapshot.pid}.json`));
  window.snapshot.pid = child.pid!; window.publish();
  await f.host.setMonitored(sessionKey(f.paths[1]), false);
  await f.host.start();
  const preferences = await readFile(join(f.root, "monitoring.json"), "utf8");
  let finish!: () => void, fail!: (error: unknown) => void;
  const stopped = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const bridge = createBridgeServer(f.host, f.journal, { host: f.host, token: "desktop-control", notificationToken: "glance-only",
    shutdown: async () => { try { await f.host.stop(); await bridge.close(); finish(); } catch (error) { fail(error); } },
  });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done)); t.after(() => bridge.close());
  const origin = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}`;
  const response = await fetch(origin + "/api/shutdown", { method: "POST", headers: { Authorization: "Bearer desktop-control" } });
  assert.equal(response.status, 200); await response.json(); await stopped;
  assert.doesNotThrow(() => process.kill(child.pid!, 0));
  await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
  assert.equal((await readdir(f.directory)).some(name => name.endsWith(".command.json")), false, "shutdown sends no terminal command");

  const restored = new NativeHost({ cwd: f.root, directory: f.directory, preferencesPath: join(f.root, "monitoring.json"),
    sessions: { root: f.sessions }, launch: async () => { assert.fail("Restart must not launch a duplicate terminal"); } });
  t.after(() => restored.stop());
  await restored.start();
  assert.equal(restored.getRuntime(key).store.state.main.status, "running");
  assert.equal(restored.store.state.monitoring?.running, 1);
  assert.equal(restored.store.state.monitoring?.watched, 1);
  assert.equal(await readFile(join(f.root, "monitoring.json"), "utf8"), preferences);
  window.store.dispatch({ type: "assistant.delta", text: "Continued through backend restart" });
  window.snapshot.at = Date.now(); window.snapshot.state = window.store.state;
  writeLocalJson(join(f.directory, `${child.pid}.json`), window.snapshot); restored.scan();
  assert.equal(restored.getRuntime(key).store.state.currentAssistantText, "Continued through backend restart");
  assert.doesNotThrow(() => process.kill(child.pid!, 0));
  assert.equal(f.journal.list().length, 0, "monitor shutdown is not job completion");
});

test("each native terminal completion notifies once; stale heartbeat never becomes completion or unwatch", async t => {
  const f = await fixture(t), first = f.make(0, true), second = f.make(1, true);
  assert.equal(f.host.store.state.monitoring!.running, 2);
  first.store.dispatch({ type: "agent.settled" }); first.snapshot.completions.push({ id: 1, at: Date.now(), outcome: "completed" }); first.publish();
  assert.equal(f.journal.list().length, 1); assert.equal(f.host.store.state.monitoring!.running, 1);
  first.publish(); assert.equal(f.journal.list().length, 1);
  second.snapshot.at = Date.now() - 7000; second.publish();
  assert.equal(f.journal.list().length, 1); assert.equal(f.host.store.state.monitoring!.watched, 2);
  await assert.rejects(f.host.resumeSession(second.store.state.session.key!), /still open/);
  assert.equal(f.launched.length, 0);
  second.snapshot.at = Date.now(); second.store.dispatch({ type: "agent.settled" });
  second.snapshot.completions.push({ id: 1, at: Date.now(), outcome: "completed" }); second.publish();
  assert.equal(f.journal.list().length, 2);
});

test("dead heartbeat cleanup is bounded, consumes final completion, and retains living owners and session history", async t => {
  const living = new Set([1000, 1001]), f = await fixture(t, pid => living.has(pid));
  const first = f.make(0, true), second = f.make(1);
  const history = await readFile(f.paths[0], "utf8");
  second.snapshot.at = Date.now() - 7000; second.publish();
  assert.ok((await readdir(f.directory)).includes("1001.json"), "a missing heartbeat with a live owner is retained");
  first.store.dispatch({ type: "agent.settled" });
  first.snapshot.completions.push({ id: 1, at: Date.now(), outcome: "completed" });
  first.snapshot.at = Date.now() - 7000;
  living.delete(1000);
  writeLocalJson(join(f.directory, `${first.snapshot.instance}.command.json`), { expired: true });
  writeLocalJson(join(f.directory, `${first.snapshot.instance}.reply.json`), { id: "old" });
  first.publish();
  assert.equal(f.journal.list().length, 1, "final completion is consumed before its dead snapshot is removed");
  assert.equal((await readdir(f.directory)).some(name => name === "1000.json" || name.startsWith(first.snapshot.instance)), false);
  for (let index = 0; index < 20; index++) writeLocalJson(join(f.directory, `${4000 + index}.json`), {
    ...first.snapshot, pid: 4000 + index, instance: randomUUID(), state: first.store.state,
  });
  f.host.scan();
  assert.equal((await readdir(f.directory)).filter(name => /^40\d\d\.json$/.test(name)).length, 4);
  f.host.scan();
  assert.equal((await readdir(f.directory)).filter(name => /^40\d\d\.json$/.test(name)).length, 0);
  assert.equal(f.host.store.state.monitoring?.watched, 2);
  assert.equal(f.journal.list().length, 1, "dead files never replay completion");
  assert.equal(await readFile(f.paths[0], "utf8"), history, "the original conversation remains intact");
});

test("background watch saves keep monitoring live during a storage failure and retry after recovery", async t => {
  const f = await fixture(t), blocked = join(f.root, "monitoring.json.tmp");
  await mkdir(blocked);
  const window = f.make(0, true);
  assert.equal(f.host.store.state.connected, true);
  assert.equal(f.host.store.state.monitoring?.watched, 1);
  window.store.dispatch({ type: "agent.settled" });
  window.snapshot.completions.push({ id: 1, at: Date.now(), outcome: "completed" });
  window.publish();
  assert.equal(f.journal.list().length, 1);
  await rm(blocked, { recursive: true });
  f.host.scan();
  const preferences = JSON.parse(await readFile(join(f.root, "monitoring.json"), "utf8"));
  assert.equal(preferences.sessions[0].key, sessionKey(f.paths[0]));
  assert.equal(preferences.sessions[0].monitored, true);
});

test("native completions use readable session names, follow renames and preserve manual Unwatch", async t => {
  const f = await fixture(t), window = f.make(0, true), key = window.store.state.session.key!;
  window.store.dispatch({ type: "user.message", text: "Repair login and test it" }); window.publish();
  window.store.dispatch({ type: "agent.settled" });
  window.snapshot.completions.push({ id: 1, at: Date.now(), outcome: "completed" }); window.publish();
  assert.equal(f.journal.list()[0].session, "Repair login and test it");
  await f.host.setMonitored(key, false);
  window.store.dispatch({ type: "session.updated", session: { name: "Login fix", model: "new-model" } }); window.publish();
  assert.equal(f.host.store.state.monitoring?.sessions[0].name, "Login fix");
  assert.equal(f.host.store.state.monitoring?.sessions[0].monitored, false);
  window.store.dispatch({ type: "agent.started" }); window.snapshot.runId = 2; window.publish();
  window.store.dispatch({ type: "agent.settled" });
  window.snapshot.completions.push({ id: 2, at: Date.now(), outcome: "completed" }); window.publish();
  assert.equal(f.journal.list().length, 1, "later native turns preserve manual Unwatch");
  await f.host.setMonitored(key, true);
  window.store.dispatch({ type: "agent.started" }); window.snapshot.runId = 3; window.publish();
  window.store.dispatch({ type: "agent.settled" });
  window.snapshot.completions.push({ id: 3, at: Date.now(), outcome: "completed" }); window.publish();
  assert.equal(f.journal.list()[1].session, "Login fix");
  assert.equal(f.launched.length, 0);
});

test("an external prompt is delivered to the original terminal and acknowledged once", async t => {
  const f = await fixture(t), window = f.make(0);
  await f.host.resumeSession(window.store.state.session.key!);
  const sending = f.host.prompt("Continue in this terminal");
  const path = join(f.directory, `${window.snapshot.instance}.command.json`);
  const command = readLocalJson(path);
  assert.equal(command.text, "Continue in this terminal"); assert.equal(command.key, sessionKey(f.paths[0]));
  writeLocalJson(join(f.directory, `${window.snapshot.instance}.reply.json`), { id: command.id });
  await sending; assert.equal(f.launched.length, 0);
});

test("headless CLI manages bridge watches and phone prompts stay pinned despite a different selected session", async t => {
  const f = await fixture(t), first = f.make(0), second = f.make(1);
  const firstKey = first.store.state.session.key!, secondKey = second.store.state.session.key!;
  await f.host.resumeSession(secondKey);
  const bridge = createBridgeServer(f.host, f.journal, { host: f.host, token: "cli-test-control", notificationToken: "cli-test-poll" });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done)); t.after(() => bridge.close());
  const origin = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}`, lines: string[] = [];
  const context = { write: (line: string) => { lines.push(line); }, request: (path: string, body?: object) => fetch(origin + path, {
    method: body ? "POST" : "GET", headers: { Authorization: "Bearer cli-test-control", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  }) };
  await runSessionCommand("unwatch", [firstKey], context);
  await runSessionCommand("sessions", ["--json"], context);
  assert.equal(JSON.parse(lines.at(-1)!).sessions.find((s: any) => s.key === firstKey).monitored, false);
  await runSessionCommand("watch", [firstKey.slice(0, 8)], context);
  assert.equal(f.host.store.state.monitoring?.sessions.find(s => s.key === firstKey)?.monitored, true);
  assert.equal(f.launched.length, 0);
  assert.equal(f.host.store.state.session.key, secondKey);
  const sending = context.request(`/api/runtime/${firstKey}/prompt`, { text: "Pinned phone prompt" });
  const path = join(f.directory, `${first.snapshot.instance}.command.json`);
  let received: any;
  for (let n = 0; n < 100; n++) {
    try { received = readLocalJson(path); break; } catch { await delay(20); }
  }
  assert.ok(received, "Target terminal receives the command");
  assert.equal(received.key, firstKey); assert.equal(received.text, "Pinned phone prompt");
  writeLocalJson(join(f.directory, `${first.snapshot.instance}.reply.json`), { id: received.id });
  const response = await sending;
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal((await readdir(f.directory)).includes(`${second.snapshot.instance}.command.json`), false);
  await runSessionCommand("select", [firstKey], context);
  assert.equal(f.host.store.state.session.key, firstKey);
  assert.equal(f.launched.length, 0, "Select reuses an already connected native terminal");
});

test("a delayed voice prompt cannot target a newly selected session and G2 cannot rewatch a removed entry", async t => {
  const f = await fixture(t), first = f.make(0), second = f.make(1);
  const firstKey = first.store.state.session.key!, secondKey = second.store.state.session.key!;
  await f.host.resumeSession(secondKey);
  const bridge = createBridgeServer(f.host, f.journal, { token: "test-control", notificationToken: "test-poll", host: f.host });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done)); t.after(() => bridge.close());
  const origin = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) => fetch(origin + path, {
    method: "POST", headers: { Authorization: "Bearer test-control", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await post("/api/prompt", { text: "stale voice reply", sessionKey: firstKey })).status, 409);
  assert.equal((await readdir(f.directory)).some(name => name.endsWith(".command.json")), false);
  await f.host.setMonitored(firstKey, false);
  assert.equal((await post("/api/session/resume", { key: firstKey, watchedOnly: true })).status, 409);
  assert.equal(f.host.store.state.session.key, secondKey);
  assert.equal(f.host.store.state.monitoring?.sessions.find(s => s.key === firstKey)?.monitored, false);
  assert.equal(f.launched.length, 0);
  assert.equal((await post("/api/session/resume", { key: secondKey, watchedOnly: true })).status, 200);
});

test("native session switches and reloads preserve watches without two live sessions for one window", async t => {
  const f = await fixture(t), first = f.make(0), second = f.make(1);
  const firstKey = sessionKey(f.paths[0]), secondKey = sessionKey(f.paths[1]);
  await f.host.resumeSession(firstKey);
  const originalStore = f.host.getRuntime(firstKey).store;
  first.snapshot.instance = randomUUID(); first.snapshot.at = Date.now(); first.publish();
  assert.equal(f.host.getRuntime(firstKey).store, originalStore);
  assert.equal(nativeSnapshot(f.host, firstKey).instance, first.snapshot.instance, "a reload in the same PID adopts its new command address");
  second.snapshot.pid = first.snapshot.pid; second.snapshot.at = Date.now() + 1; second.publish();
  assert.equal(f.host.getRuntime(firstKey).store.state.connected, false);
  assert.equal(f.host.getRuntime(secondKey).store.state.connected, true);
  assert.equal(f.host.store.state.monitoring?.watched, 2);
  assert.equal(f.journal.list().length, 0);
});

test("an unregistered existing Pi blocks resuming a saved file without modifying it", async t => {
  const f = await fixture(t);
  const original = await readFile(f.paths[0], "utf8");
  const host = new NativeHost({ cwd: f.root, directory: f.directory, sessions: { root: f.sessions },
    preferencesPath: join(f.root, "guard.json"), alive: () => true, unregistered: async () => true,
    launch: async path => { f.launched.push(path); } });
  t.after(() => host.stop());
  await assert.rejects(host.resumeSession(sessionKey(f.paths[0])), /reload/);
  assert.equal(f.launched.length, 0);
  assert.equal(await readFile(f.paths[0], "utf8"), original);
  assert.equal((await host.listSessions()).sessions.length, 2);
});

test("a fresh Pi session opens independently of unrelated unregistered terminals and is watched once", async t => {
  const f = await fixture(t), originals = await Promise.all(f.paths.map(path => readFile(path, "utf8")));
  let guardChecks = 0;
  const host = new NativeHost({ cwd: f.root, directory: f.directory, sessions: { root: f.sessions },
    preferencesPath: join(f.root, "fresh.json"), alive: () => true,
    unregistered: async () => { guardChecks++; return true; },
    launch: async (path, cwd, tunnel, fresh) => {
      assert.equal(cwd, f.root); assert.equal(tunnel, "pi"); assert.equal(fresh, true);
      f.launched.push(path);
    } });
  t.after(() => host.stop());
  await host.newSession({ cwd: f.root, name: "Separate work" });
  assert.equal(guardChecks, 0, "Only a newly reserved identity bypasses the resume guard");
  assert.equal(f.launched.length, 1);
  const path = f.launched[0], key = sessionKey(path);
  assert.ok(!f.paths.includes(path), "Fresh work uses its own session file");
  const header = JSON.parse((await readFile(path, "utf8")).split("\n")[0]);
  assert.match(header.id, /^[a-f0-9-]{36}$/); assert.notEqual(header.id, "source-0"); assert.notEqual(header.id, "source-1");
  assert.deepEqual(await Promise.all(f.paths.map(path => readFile(path, "utf8"))), originals);
  const row = (await host.listSessions()).sessions.find(session => session.key === key);
  assert.equal(row?.name, "Separate work"); assert.equal(row?.active, true); assert.equal(row?.monitored, true);
  assert.equal(host.store.state.session.key, key);
  await host.openMonitoredSession(key);
  assert.deepEqual(f.launched, [path], "Repeated opening reuses the launch already in progress");
  await assert.rejects(host.resumeSession(sessionKey(f.paths[0])), /reload/);
  assert.equal(guardChecks, 1, "Existing saved files still require duplicate-writer protection");
  assert.deepEqual(await Promise.all(f.paths.map(path => readFile(path, "utf8"))), originals);
});

test("real extension callbacks update snapshots, redact hidden/tool data, and receive prompt commands", async t => {
  const handlers = new Map<string, (event: any, context: any) => void>();
  const old = process.env.EVEN_PILOT_DATA_DIR;
  t.after(() => { handlers.get("session_shutdown")?.({}, undefined); if (old === undefined) delete process.env.EVEN_PILOT_DATA_DIR; else process.env.EVEN_PILOT_DATA_DIR = old; });
  const f = await fixture(t);
  process.env.EVEN_PILOT_DATA_DIR = f.root;
  let sent = "", interrupted = false, idle = true;
  const ctx = { mode: "tui", cwd: f.root, isIdle: () => idle, abort: () => { interrupted = true; },
    sessionManager: { getSessionFile: () => f.paths[0], getSessionId: () => "source-0", getSessionName: () => "Original Pi",
      getBranch: () => savedEntries(f.root) } };
  monitor({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: text => { sent = text; } });
  handlers.get("session_start")!({}, ctx);
  const snapshotPath = join(f.directory, `${process.pid}.json`);
  let snapshot = readLocalJson(snapshotPath) as NativeSnapshot;
  assert.equal(snapshot.state.session.name, "Original Pi");
  assert.doesNotMatch(JSON.stringify(snapshot), /private reasoning|raw secret tool payload/);
  const instance = snapshot.instance;
  writeLocalJson(join(f.directory, `${instance}.command.json`), { id: "test", instance, key: sessionKey(f.paths[0]), type: "prompt", text: "Relay me", expiresAt: Date.now() + 5000 });
  await delay(300); assert.equal(sent, "Relay me");
  handlers.get("agent_start")!({ type: "agent_start" }, ctx);
  handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolName: "subagent", toolCallId: "parallel",
    args: { tasks: [{ agent: "worker" }, { agent: "worker" }, { agent: "worker" }] } }, ctx);
  handlers.get("tool_execution_update")!({ type: "tool_execution_update", toolName: "subagent", toolCallId: "parallel",
    partialResult: { details: { mode: "parallel", results: Array.from({ length: 3 }, () => ({ exitCode: 0, stopReason: "toolUse", messages: "private reasoning" })) } } }, ctx);
  handlers.get("model_select")!({ model: { provider: "deepseek", id: "new-model" } }, ctx);
  await delay(300); snapshot = readLocalJson(snapshotPath);
  assert.equal(sessionAgentCount(snapshot.state, true), "3");
  assert.equal(snapshot.state.session.model, "deepseek/new-model");
  assert.doesNotMatch(JSON.stringify(snapshot), /private reasoning/);
  handlers.get("message_start")!({ type: "message_start", message: { role: "user", content: "new terminal message" } }, ctx);
  handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
  await delay(300); snapshot = readLocalJson(snapshotPath);
  assert.equal(snapshot.state.transcript.at(-1)?.text, "new terminal message"); assert.equal(snapshot.completions.length, 1);
  const previousRun = snapshot.runId;
  idle = false; handlers.get("agent_start")!({ type: "agent_start" }, ctx);
  writeLocalJson(join(f.directory, `${instance}.command.json`), { id: "stale-stop", instance, key: sessionKey(f.paths[0]), runId: previousRun, type: "interrupt", expiresAt: Date.now() + 5000 });
  await delay(300); assert.equal(interrupted, false, "A delayed stop cannot cancel the next instruction");
  snapshot = readLocalJson(snapshotPath);
  writeLocalJson(join(f.directory, `${instance}.command.json`), { id: "stop", instance, key: sessionKey(f.paths[0]), runId: snapshot.runId, type: "interrupt", expiresAt: Date.now() + 5000 });
  await delay(300); assert.equal(interrupted, true);
});
