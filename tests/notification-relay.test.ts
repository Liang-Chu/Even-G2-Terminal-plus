import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationRelay } from "../apps/windows/src/notification-relay.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { GlancePush } from "../apps/windows/src/push.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { TestRuntime, completeSession } from "./fixtures/runtime.js";

const sourceId = "11111111-1111-4111-8111-111111111111", centerId = "22222222-2222-4222-8222-222222222222";
const identity = (id = sourceId, name = "Laptop") => ({ id, name, nameSource: "hostname" as const });
const registration = { subscription_id: "phone-watch", installation_id: "phone-fid", watcher: "Work", max_length: 120, title_max_length: 32, expires_after_seconds: 30 };
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "pilot-relay-"));
  const source = new TestRuntime({ cwd: "/project" }), center = new TestRuntime({ cwd: "/center" });
  const journal = new NotificationJournal(source.store, join(root, "source-journal.json"));
  const central = new NotificationJournal(center.store, join(root, "central-journal.json"));
  const incoming = new NotificationRelay(central, { identity: identity(centerId, "NUC"), path: join(root, "center-route.json"), canSend: () => true, automatic: false });
  const peer = incoming.register({ sourceId, sourceName: "Laptop" });
  const target = { ...peer, url: "http://center.invalid:4317" };
  const request: typeof fetch = async (url, init) => {
    const key = String((init!.headers as any).Authorization).slice(7);
    return new Response(JSON.stringify(String(url).endsWith("/probe") ? incoming.probe(key) : incoming.receive(key, JSON.parse(String(init!.body)))), { status: 200 });
  };
  const outgoing = new NotificationRelay(journal, { identity: identity(), path: join(root, "source-route.json"), canSend: () => true, automatic: false, fetch: request });
  t.after(async () => { await outgoing.close(); await incoming.close(); journal.close(); central.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, source, center, journal, central, incoming, outgoing, target, request };
}

test("one center delivers local and forwarded completions; source does not also send or poll", async t => {
  const f = fixture(t), sourceSent: any[] = [], centerSent: any[] = [];
  const direct = new GlancePush(f.journal, { automatic: false, sender: { send: async payload => { sourceSent.push(payload); return { name: "ok" }; } } });
  const centralPush = new GlancePush(f.central, { automatic: false, sender: { send: async payload => { centerSent.push(payload); return { name: "ok" }; } } });
  t.after(async () => { await direct.close(); await centralPush.close(); }); direct.register(registration); centralPush.register(registration);
  await f.outgoing.configure({ mode: "relay", target: f.target });
  completeSession(f.source.store); await f.outgoing.drain(); await direct.drain(); await centralPush.drain();
  assert.equal(sourceSent.length, 0); assert.equal(centerSent.length, 1); assert.match(centerSent[0].message.data.text, /Laptop · project/);
  assert.equal(f.journal.poll("local", 120, 32), undefined);
  completeSession(f.center.store); await centralPush.drain(); assert.equal(centerSent.length, 2);
  assert.equal(f.outgoing.status().queued, 0); assert.equal(f.incoming.status().mode, "direct");
  assert.doesNotMatch(JSON.stringify(f.outgoing.status()), new RegExp(f.target.key));
  assert.doesNotMatch(readFileSync(join(f.root, "center-route.json"), "utf8"), new RegExp(f.target.key));
});

test("retry after a lost acknowledgement and restart cannot duplicate the central event", async t => {
  const f = fixture(t); let clock = Date.now(), lose = true;
  await f.outgoing.close();
  const path = join(f.root, "retry-route.json");
  const outgoing = new NotificationRelay(f.journal, { path, identity: identity(), canSend: () => false, automatic: false, now: () => clock,
    fetch: async (url, init) => { const response = await f.request(url, init); if (String(url).endsWith("/event") && lose) { lose = false; throw new TypeError("Lost reply"); } return response; } });
  await outgoing.configure({ mode: "relay", target: f.target }); completeSession(f.source.store); await outgoing.drain();
  assert.equal(f.central.list().length, 1); assert.equal(outgoing.status().queued, 1); await outgoing.close(); clock += 2000;
  const restarted = new NotificationRelay(f.journal, { path, identity: identity(), canSend: () => false, automatic: false, now: () => clock, fetch: f.request });
  t.after(() => restarted.close()); await restarted.drain();
  assert.equal(restarted.status().queued, 0); assert.equal(f.central.list().length, 1);
  f.central.close(); const restored = new NotificationJournal(f.center.store, join(f.root, "central-journal.json")); t.after(() => restored.close());
  assert.equal(restored.receiveRelay(sourceId, "Laptop", f.journal.list()[0]), false);
});

test("G2 suppression, expiration and switching back to independent sending do not replay", async t => {
  const f = fixture(t);
  await f.outgoing.configure({ mode: "relay", target: f.target });
  const viewedKey = "a".repeat(32);
  f.journal.g2.update({ clientId: "b".repeat(32), sequence: 1, sessionKey: viewedKey });
  // Exercise persisted suppression independent of any hardware presence lease.
  const before = f.journal.list().length;
  f.source.store.publish(f.source.store.state, { type: "monitoring.settled", session: "Viewed", sessionKey: viewedKey, outcome: "completed" });
  const event = f.journal.list()[before];
  assert.equal(event.viewedOnG2, true); await f.outgoing.drain(); assert.equal(f.central.list().length, 0);
  await f.outgoing.configure({ mode: "direct" }); completeSession(f.source.store);
  assert.equal(f.journal.list().at(-1)?.forwardTo, undefined); await f.outgoing.drain(); assert.equal(f.central.list().length, 0);
  const expired = { ...event, id: 90, viewedOnG2: false, at: Date.now() - 11 * 60_000, forwardTo: centerId };
  assert.equal(f.incoming.receive(f.target.key, { event: expired }).skipped, true);
});

test("relay credentials are scoped; self routes and forwarding chains are rejected", async t => {
  const f = fixture(t);
  assert.throws(() => f.incoming.probe("invalid"), /credential/);
  await assert.rejects(f.outgoing.configure({ mode: "relay", target: { ...f.target, id: sourceId } }), /Invalid relay/);
  await assert.rejects(f.outgoing.configure({ mode: "relay", target: { ...f.target, url: "http://user:secret@center.invalid" } }), /without credentials/);
  await f.outgoing.configure({ mode: "relay", target: f.target });
  assert.throws(() => f.outgoing.register({ sourceId: centerId, sourceName: "NUC" }), /forwards elsewhere/);
  await assert.rejects(f.incoming.configure({ mode: "relay", target: { ...f.target, id: sourceId } }), /incoming relay sources/);
  f.incoming.revoke(sourceId); assert.throws(() => f.incoming.probe(f.target.key), /credential/);
});

test("HTTP relay endpoint accepts only a scoped peer credential; control APIs remain protected", async t => {
  const f = fixture(t), control = "relay-control-test-credential", notify = "relay-notification-test-key";
  const server = createBridgeServer(f.center, f.central, { token: control, notificationToken: notify, relay: f.incoming });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.server.address() as any).port}`;
  const request = (path: string, key: string, data?: unknown) => fetch(base + path, { method: data ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  assert.equal((await request("/api/state", f.target.key)).status, 401);
  assert.equal((await request("/api/glance/routing", notify)).status, 403);
  assert.equal((await request("/api/glance/relay/register", notify, { sourceId, sourceName: "Laptop" })).status, 403);
  assert.equal((await request("/api/glance/relay/probe", control, {})).status, 401);
  assert.equal((await request("/api/glance/relay/probe", f.target.key, {})).status, 200);
  const event = { id: 1, at: Date.now(), session: "Test", outcome: "completed", forwardTo: centerId };
  assert.equal((await request("/api/glance/relay/event", f.target.key, { event })).status, 200);
  assert.equal((await request("/api/glance/relay/event", f.target.key, { event })).status, 200);
  assert.equal(f.central.list().length, 1);
  assert.equal((await request("/api/glance/relay/event", f.target.key, { event: { ...event, relayedFrom: sourceId } })).status, 400);
});
