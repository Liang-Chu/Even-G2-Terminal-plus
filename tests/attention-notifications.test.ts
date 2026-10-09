import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { GlancePush } from "../apps/windows/src/push.js";
import { NotificationRelay } from "../apps/windows/src/notification-relay.js";
import { TestRuntime } from "./fixtures/runtime.js";
import { createBridgeServer } from "../apps/windows/src/server.js";

const key = "a".repeat(32), id = "b".repeat(64);
const sourceId = "11111111-1111-4111-8111-111111111111", centerId = "22222222-2222-4222-8222-222222222222";
const registration = { subscription_id: "attention-watch", installation_id: "phone-fid", watcher: "Work", max_length: 120,
  title_max_length: 32, expires_after_seconds: 30 };
const identity = (id: string, name: string) => ({ id, name, nameSource: "hostname" as const });
function attention(store: CockpitStore, requests: any[], sessionKey = key) {
  store.publish(store.state, { type: "monitoring.attention", sessionKey, sessionId: "visible-session", session: "Readable project", requests });
}
function request(extra: any = {}) { return { id, kind: "question", createdAt: Date.now(), ...extra }; }
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "terminal-attention-")), store = new CockpitStore("/project"), path = join(root, "journal.json");
  const journal = new NotificationJournal(store, path);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, journal, path };
}

test("verified pending requests are durable identities, not repeated heartbeat or completion notices", async t => {
  const f = fixture(t), sent: any[] = [], push = new GlancePush(f.journal, { automatic: false, sender: { send: async payload => { sent.push(payload); return { name: "mock" }; } } });
  t.after(() => push.close()); push.register(registration);
  f.journal.g2.update({ clientId: "c".repeat(32), sequence: 1, sessionKey: key });
  attention(f.store, [request()]); attention(f.store, [request()]);
  assert.equal(f.journal.list().length, 1); assert.equal(f.journal.list()[0].kind, "attention");
  f.store.publish(f.store.state, { type: "monitoring.settled", sessionKey: key, session: "Readable project", outcome: "completed" });
  assert.equal(f.journal.list().length, 1, "Pending input cannot be mislabeled as job complete");
  await push.drain(); assert.equal(sent.length, 1); assert.match(sent[0].message.data.text, /^Needs input · Readable project/);
  assert.doesNotMatch(JSON.stringify(sent), /question|attentionId|options|command/);
  const restoredStore = new CockpitStore("/project"), restored = new NotificationJournal(restoredStore, f.path); t.after(() => restored.close());
  attention(restoredStore, [request()]); assert.equal(restored.list().length, 1);
  assert.equal(restored.attentionPending(id), true);
  attention(f.store, []); assert.equal(f.journal.list().at(-1)?.kind, "attention-resolved");
  assert.equal(f.journal.attentionPending(id), false);
  attention(f.store, [request()]); assert.equal(f.journal.list().length, 2, "Stale snapshot cannot revive resolved input");
});

test("historical baselines and 30-second delivery expiry stay quiet while UI identity remains pending", async t => {
  const f = fixture(t), sent: any[] = [], push = new GlancePush(f.journal, { ttlSeconds: 3600, automatic: false,
    sender: { send: async payload => { sent.push(payload); return { name: "mock" }; } } });
  t.after(() => push.close()); push.register(registration);
  attention(f.store, [request({ baseline: true })]); assert.equal(f.journal.list().length, 0); assert.equal(f.journal.attentionPending(id), true);
  attention(f.store, [request({ id: "c".repeat(64), createdAt: Date.now() - 31_000 })]);
  assert.equal(f.journal.poll("late-watcher", 120, 32), undefined);
  await push.drain(); assert.equal(sent.length, 0); assert.equal(f.journal.attentionPending("c".repeat(64)), true);
  attention(f.store, [request({ id: "d".repeat(64), expiresAt: Date.now() + 9000 })]);
  const job = push.status().jobs.at(-1)!;
  assert.ok(job.expiresAt <= Date.now() + 9100, "Prompt expiry further shortens the delivery window");
});

test("resolutions cancel queued and in-flight pushes; late sender acceptance cannot restore them", async t => {
  const f = fixture(t); let finish!: () => void, entered!: () => void, aborted = false;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const push = new GlancePush(f.journal, { path: join(f.root, "push.json"), automatic: false, sender: { send: async (_payload, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }); entered(); await new Promise<void>(resolve => { finish = resolve; }); return { name: "mock" };
  } } }); t.after(() => push.close()); push.register(registration);
  attention(f.store, [request()]); const sending = push.drain(); await enteredPromise;
  attention(f.store, []); assert.equal(aborted, true); finish(); await sending;
  assert.equal(push.status().jobs[0].status, "cancelled"); assert.equal(push.status().jobs[0].code, "INPUT_RESOLVED");
  attention(f.store, [request({ id: "c".repeat(64) })]); attention(f.store, []);
  assert.equal(push.status().jobs.at(-1)?.status, "cancelled");
});

test("restart recovers pending cancellation even after the resolution is outside the 100-event tail", async t => {
  const f = fixture(t), path = join(f.root, "push.json"), push = new GlancePush(f.journal, { path, automatic: false });
  push.register(registration); attention(f.store, [request()]); await push.close(); attention(f.store, []);
  for (let i = 0; i < 105; i++) f.store.publish(f.store.state, { type: "monitoring.settled", session: "Other project", outcome: "completed" });
  const recovered = new GlancePush(f.journal, { path, automatic: false }); t.after(() => recovered.close());
  assert.equal(recovered.status().jobs.find(job => job.attentionId === id)?.status, "cancelled");
});

test("failed journal saves do not deliver uncommitted requests and retry exactly once", async t => {
  const f = fixture(t), blocked = f.path + ".tmp"; mkdirSync(blocked); let delivered = 0;
  f.journal.subscribe(() => { delivered++; }); attention(f.store, [request()]);
  assert.equal(f.journal.list().length, 0); assert.equal(f.journal.attentionPending(id), false); assert.equal(delivered, 0);
  rmSync(blocked, { recursive: true }); await delay(1200);
  assert.equal(f.journal.list().length, 1); assert.equal(f.journal.attentionPending(id), true); assert.equal(delivered, 1);
});

test("persisted attention metadata is bounded and rejects malformed state without showing private fields", t => {
  const f = fixture(t), row = { session: "Private request", reason: "question", at: Date.now(), eventId: 1, active: true };
  for (const attentionData of [{ [id]: { ...row, reason: "command with secret" } }, Object.fromEntries(Array.from({ length: 2049 }, (_, i) => [i.toString(16).padStart(64, "0"), row]))]) {
    writeFileSync(f.path, JSON.stringify({ nextId: 2, events: [], watchers: {}, attention: attentionData }));
    assert.throws(() => new NotificationJournal(new CockpitStore("/project"), f.path), /^Error: Invalid notification journal/);
  }
});

test("relay carries one minimal input notice then ordered resolution, and never sends from both hosts", async t => {
  const f = fixture(t), center = new CockpitStore("/center"), central = new NotificationJournal(center), sent: any[] = [];
  const incoming = new NotificationRelay(central, { identity: identity(centerId, "NUC"), canSend: () => true, automatic: false });
  const target = { ...incoming.register({ sourceId, sourceName: "Laptop" }), url: "http://center.invalid" };
  const wire: any[] = [];
  const outgoing = new NotificationRelay(f.journal, { identity: identity(sourceId, "Laptop"), canSend: () => false, automatic: false,
    fetch: async (url, init) => {
      const data = JSON.parse(String(init?.body)); wire.push(data);
      return new Response(JSON.stringify(String(url).endsWith("/probe") ? incoming.probe(target.key) : incoming.receive(target.key, data)), { status: 200 });
    } });
  const push = new GlancePush(central, { automatic: false, sender: { send: async payload => { sent.push(payload); return { name: "mock" }; } } });
  const local = new GlancePush(f.journal, { automatic: false, sender: { send: async () => assert.fail("Source must forward") } });
  t.after(async () => { await outgoing.close(); await incoming.close(); await local.close(); await push.close(); central.close(); });
  push.register(registration); local.register(registration); await outgoing.configure({ mode: "relay", target });
  attention(f.store, [request({ kind: "approval" })]); await outgoing.drain(); await local.drain();
  assert.equal(central.list().length, 1); assert.equal(push.status().jobs.length, 1);
  attention(f.store, []); await outgoing.drain(); await push.drain();
  assert.equal(sent.length, 0); assert.equal(push.status().jobs[0].status, "cancelled");
  assert.deepEqual(central.list().map(event => event.kind), ["attention", "attention-resolved"]);
  assert.doesNotMatch(JSON.stringify(wire), /question text|options|tool_input|command/);
  const event = { ...f.journal.list()[0], id: 50, question: "private", options: ["secret"], forwardTo: centerId };
  assert.equal(incoming.receive(target.key, { event }).inserted, false, "Identity dedup survives changed transport IDs");
  assert.doesNotMatch(JSON.stringify(central.list()), /private|secret/);
});

test("offline relay cannot revive a resolved or old request; cancellation records survive late watcher registration", async t => {
  const f = fixture(t), center = new CockpitStore("/center"), central = new NotificationJournal(center);
  const incoming = new NotificationRelay(central, { identity: identity(centerId, "NUC"), canSend: () => true, automatic: false });
  const target = { ...incoming.register({ sourceId, sourceName: "Laptop" }), url: "http://center.invalid" };
  const outgoing = new NotificationRelay(f.journal, { identity: identity(sourceId, "Laptop"), canSend: () => false, automatic: false,
    fetch: async (url, init) => new Response(JSON.stringify(String(url).endsWith("/probe") ? incoming.probe(target.key) : incoming.receive(target.key, JSON.parse(String(init?.body)))), { status: 200 }) });
  t.after(async () => { await outgoing.close(); await incoming.close(); central.close(); }); await outgoing.configure({ mode: "relay", target });
  attention(f.store, [request()]); attention(f.store, []); await outgoing.drain();
  assert.deepEqual(central.list().map(event => event.kind), ["attention-resolved"]);
  assert.equal(central.poll("new-phone", 120, 32), undefined);
  assert.equal(incoming.receive(target.key, { event: { kind: "attention", id: 40, attentionId: id, reason: "question", session: "Old", at: Date.now() - 31_000, forwardTo: centerId } }).skipped, true);
  assert.throws(() => incoming.receive(target.key, { event: { kind: "attention", id: 41, attentionId: id, reason: "command", session: "Secret", at: Date.now(), forwardTo: centerId } }), /Invalid relayed notification/);
});

test("attention and resolution are excluded from completion HTTP and SSE history", async t => {
  const f = fixture(t), runtime = new TestRuntime({ cwd: "/project" });
  attention(f.store, [request()]); attention(f.store, []);
  f.store.publish(f.store.state, { type: "monitoring.settled", session: "Actual completion", outcome: "completed" });
  const server = createBridgeServer(runtime, f.journal, { token: "test-control-token", notificationToken: "test-notification-token" });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.server.address() as any).port}`;
  const response = await fetch(base + "/api/completions", { headers: { Authorization: "Bearer test-control-token" } });
  const data = await response.json() as any;
  assert.equal(data.events.length, 1); assert.equal(data.events[0].session, "Actual completion");
  const controller = new AbortController(), stream = await fetch(base + "/api/events", {
    headers: { Authorization: "Bearer test-control-token" }, signal: controller.signal,
  });
  const reader = stream.body!.getReader(); let replay = "";
  while (!replay.includes("Actual completion")) replay += new TextDecoder().decode((await reader.read()).value);
  assert.equal((replay.match(/event: completion/g) || []).length, 1); assert.doesNotMatch(replay, /attention-resolved|Needs input/);
  attention(f.store, [request({ id: "c".repeat(64) })]); attention(f.store, []);
  f.store.publish(f.store.state, { type: "monitoring.settled", session: "Second completion", outcome: "completed" });
  let live = ""; while (!live.includes("Second completion")) live += new TextDecoder().decode((await reader.read()).value);
  assert.equal((live.match(/event: completion/g) || []).length, 1); assert.doesNotMatch(live, /attention-resolved|Readable project/);
  controller.abort(); await reader.cancel().catch(() => {});
});

test("relay ledger retires expired markers and listener exceptions cannot undo a durable acknowledgement", t => {
  const f = fixture(t), at = Date.now() - 10_000;
  const records = Object.fromEntries(Array.from({ length: 2048 }, (_, i) => [i.toString(16).padStart(64, "0"), {
    session: "Expired", reason: "question", at, eventId: i + 1, active: true, expiresAt: at + 1,
  }]));
  writeFileSync(f.path, JSON.stringify({ nextId: 2049, events: [], watchers: {}, attention: records }));
  const restored = new NotificationJournal(new CockpitStore("/project"), f.path); t.after(() => restored.close());
  restored.subscribe(() => { throw new Error("Broken independent listener"); });
  assert.equal(restored.receiveRelay(sourceId, "Laptop", { kind: "attention", attentionId: id, reason: "question", id: 1, at: Date.now(), session: "Current" }), true);
  const saved = JSON.parse(readFileSync(f.path, "utf8")); assert.equal(Object.keys(saved.attention).length, 2048);
  assert.equal(restored.attentionPending(sourceId + ":" + id), true);
  assert.equal(restored.receiveRelay(sourceId, "Laptop", { kind: "attention", attentionId: id, reason: "question", id: 1, at: Date.now(), session: "Current" }), false);
});
