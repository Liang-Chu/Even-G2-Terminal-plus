import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { G2Presence, G2_VIEW_LEASE_MS } from "../apps/windows/src/g2-presence.js";
import { G2PresenceReporter } from "../apps/evenhub/src/bridge/presence.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { GlancePush } from "../apps/windows/src/push.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { G2Display } from "../apps/evenhub/src/g2/display.js";

const a = "a".repeat(32), b = "b".repeat(32), viewer = "c".repeat(32);
test("viewing leases expire independently of Watch, reject stale reports and retain release tombstones", () => {
  let now = 0;
  const presence = new G2Presence(() => now);
  const report = (sequence: number, sessionKey: string | null, clientId = viewer) => presence.update({ clientId, sequence, sessionKey });
  report(1, a); assert.equal(presence.viewing(a), true); assert.equal(presence.viewing(b), false);
  report(3, b); report(2, a);
  assert.equal(presence.viewing(a), false); assert.equal(presence.viewing(b), true);
  report(4, null); report(3, a); assert.equal(presence.viewing(b), false); assert.equal(presence.viewing(a), false);
  report(5, a); report(1, b, "d".repeat(32));
  assert.equal(presence.viewing(a), true); assert.equal(presence.viewing(b), true);
  now += G2_VIEW_LEASE_MS;
  assert.equal(presence.viewing(a), false); assert.equal(presence.viewing(b), false);
  assert.throws(() => report(6, "bad-key"), /Invalid/);
  assert.throws(() => report(0, a), /Invalid/);
});

test("phone viewing reporter renews only the current glasses session and releases on disconnect", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent: any[] = [];
  const reporter = new G2PresenceReporter(async data => { sent.push(data); }, viewer);
  reporter.set(undefined); assert.equal(sent.length, 0, "phone-only preview reports nothing");
  reporter.set(a); reporter.set(a); assert.equal(sent.length, 1);
  t.mock.timers.tick(5000); assert.equal(sent.length, 2);
  reporter.set(b); assert.equal(sent.at(-1).sessionKey, b);
  reporter.suspend(); assert.equal(sent.at(-1).sessionKey, null);
  const stopped = sent.length; t.mock.timers.tick(30_000); reporter.set(a); assert.equal(sent.length, stopped);
  reporter.resume(); reporter.set(a); assert.equal(sent.at(-1).sessionKey, a);
  assert.deepEqual(sent.map(row => row.sequence), sent.map((_, i) => i + 1));
  reporter.suspend();
});

test("authenticated G2 view suppresses only that session's push/poll and never replays it after exit or restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "pilot-presence-")), path = join(root, "journal.json"), pushPath = join(root, "push.json");
  const store = new CockpitStore("fixture"), journal = new NotificationJournal(store, path);
  const push = new GlancePush(journal, { path: pushPath, automatic: false });
  const bridge = createBridgeServer({ store } as any, journal, { token: "view-control", notificationToken: "view-notify", push });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  t.after(async () => { await bridge.close(); await push.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(bridge.server.address() as any).port}`;
  const post = (data: object, token = "view-control") => fetch(origin + "/api/g2/view", { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const report = { clientId: viewer, sequence: 1, sessionKey: a };
  assert.equal((await post(report, "view-notify")).status, 403);
  assert.equal((await post(report, "wrong")).status, 401);
  assert.equal((await post({ ...report, sessionKey: "invalid" })).status, 400);
  assert.equal((await post(report)).status, 200);
  push.register({ subscription_id: "fixture", installation_id: "fake-fid", watcher: "test", max_length: 80, title_max_length: 32, expires_after_seconds: 30 });
  const complete = (key: string) => store.publish(store.state, { type: "monitoring.settled", sessionKey: key, sessionId: key,
    session: key === a ? "Session A" : "Session B", outcome: "completed" });
  complete(a); complete(b);
  assert.equal(journal.list().length, 2, "completion history remains available");
  assert.equal(journal.list()[0].viewedOnG2, true);
  assert.equal(push.status().jobs.length, 1);
  assert.equal(journal.poll("phone", 80, 32)?.text, "Job complete · Session B");
  assert.equal((await post({ ...report, sequence: 2, sessionKey: null })).status, 200);
  assert.equal(journal.poll("phone", 80, 32), undefined, "exit does not replay the seen completion");
  complete(a); assert.equal(push.status().jobs.length, 2);
  assert.equal(journal.poll("phone", 80, 32)?.text, "Job complete · Session A");
  await post({ ...report, sequence: 3 }); complete(a);
  assert.equal(journal.poll("phone", 80, 32), undefined);
  await push.close(); journal.close();
  const restored = new NotificationJournal(new CockpitStore("fixture"), path);
  const restoredPush = new GlancePush(restored, { path: pushPath, automatic: false });
  t.after(async () => { await restoredPush.close(); restored.close(); });
  assert.equal(restoredPush.status().jobs.length, 2);
  assert.equal(restored.poll("phone", 80, 32), undefined);
  assert.equal(restored.g2.viewing(a), false, "viewing is not persisted as permanent mute");
});

test("only mounted G2 conversation/voice pages report viewing; picker, failed display and exits release it", async t => {
  const store = new CockpitStore("fixture"); store.dispatch({ type: "session.updated", session: { key: a } });
  let viewed: string | undefined, accepted = false;
  const display = new G2Display(() => {}, () => {}, { list: async () => [], open: async () => store.state }, {
    renderer: { pages: text => [text], render: () => [] }, viewed: key => { viewed = key; },
  });
  t.after(() => display.dispose());
  display.update(store.state, true); assert.equal(viewed, undefined);
  const bridge = { onEvenHubEvent: () => () => {},
    createStartUpPageContainer: async () => accepted ? 0 : 1, rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true, updateImageRawData: async () => "success" };
  await display.init(bridge as any); assert.equal(viewed, undefined);
  accepted = true; display.resync(); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(viewed, a);
  display.handleEvent({ sysEvent: { eventType: 4 } } as any); assert.equal(viewed, a, "OS menu isn't an app exit");
  display.handleEvent({ sysEvent: { eventType: 5 } } as any);
  await display.openSessions(); assert.equal(viewed, undefined);
  display.back(); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(viewed, a);
  display.setComposer({ text: "Listening", hint: "Release to finish" }); await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(viewed, a);
  display.update(store.state, false); assert.equal(viewed, undefined);
  display.update(store.state, true); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(viewed, a);
  display.handleEvent({ sysEvent: { eventType: 7 } } as any); assert.equal(viewed, undefined);
});
