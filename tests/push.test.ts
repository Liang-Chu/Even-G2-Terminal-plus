import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GlancePush, buildPushPayload, type PushSubscription } from "../apps/windows/src/push.js";
import { FcmFailure, FcmSender, validateFirebaseProjectId, type FcmPayload, type PushSender } from "../apps/windows/src/fcm.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { TestRuntime, completeSession } from "./fixtures/runtime.js";
import { createBridgeServer } from "../apps/windows/src/server.js";

const registration = { operation: "register_push", subscription_id: "watcher-a", installation_id: "phone-fid",
  watcher: "Build alerts", max_length: 80, title_max_length: 32, expires_after_seconds: 3, client: "Glance", firebase_project_id: "even-glance" };
const subscription: PushSubscription = { id: "watcher-a", installationId: "phone-fid", watcher: "Build alerts",
  maxLength: 80, titleMaxLength: 32, expiresAfterSeconds: 3, registeredAt: 0, lastCompletionId: 0 };
const control = "push-test-control-123456789";
const credential = "push-test-glance-123456789";

function fixture(t: any, sender?: PushSender, clock?: () => number) {
  const runtime = new TestRuntime({ cwd: "C:\\work\\project" });
  const journal = new NotificationJournal(runtime.store);
  const root = mkdtempSync(join(tmpdir(), "even-pilot-push-"));
  const path = join(root, "push.json");
  const push = new GlancePush(journal, { path, sender, now: clock, automatic: false, random: () => 0, projectId: "even-glance" });
  t.after(async () => { await push.close(); journal.close(); rmSync(root, { force: true, recursive: true }); });
  return { runtime, journal, push, path };
}

test("a full push queue retains the completion cursor until capacity is available", async t => {
  const { runtime, push } = fixture(t, { send: async () => ({ name: "accepted" }) });
  push.register(registration);
  for (let n = 0; n < 500; n++) push.test({ subscription_id: "watcher-a", title: "Fixture", text: "Queued" });
  completeSession(runtime.store);
  assert.equal(push.status().subscriptions[0].lastCompletionId, 0);
  await push.drain();
  assert.equal(push.status().subscriptions[0].lastCompletionId, 1);
  assert.equal(push.status().jobs.filter(job => job.eventId === 1).length, 1);
  await push.drain();
  assert.equal(push.status().jobs.filter(job => job.eventId === 1).length, 1);
});

test("push registration is authenticated, upserts only its watcher, persists removal tombstones, and never polls content", async t => {
  const { runtime, journal, push, path } = fixture(t);
  const bridge = createBridgeServer(runtime, journal, { token: control, notificationToken: credential, push });
  await new Promise<void>(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
  t.after(() => bridge.close());
  const address = bridge.server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (data: unknown, auth = `Bearer ${credential}`, path = "/api/glance") => fetch(url + path, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(data),
  });
  completeSession(runtime.store);
  assert.equal((await post(registration, "")).status, 401);
  assert.equal((await post(registration, credential)).status, 401);
  const first = await post(registration); assert.equal(first.status, 204); assert.equal(await first.text(), "");
  assert.equal((await post({ ...registration, subscription_id: "watcher-b" })).status, 204);
  assert.equal((await post({ ...registration, watcher: "Updated", installation_id: "new-fid", max_length: 40 })).status, 204);
  assert.equal(push.status().subscriptions.length, 2);
  assert.equal(push.status().subscriptions.find(s => s.id === "watcher-a")!.maxLength, 40);
  assert.equal(JSON.stringify(push.status()).includes("new-fid"), false);
  const disk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(disk.subscriptions.find((s: any) => s.id === "watcher-b").installationId, "phone-fid");
  assert.equal(disk.subscriptions.find((s: any) => s.id === "watcher-a").installationId, "new-fid");
  assert.equal(push.status().jobs.length, 0); // Registering never replays an older completed job.
  const remove = { operation: "unregister_push", subscription_id: "watcher-a", client: "Glance" };
  assert.equal((await post(remove)).status, 204); assert.equal((await post(remove)).status, 204);
  assert.equal((await post(registration)).status, 410);
  assert.equal((await post({ operation: "unregister_push", subscription_id: "never-seen" })).status, 204);
  assert.equal((await post({ ...registration, subscription_id: "never-seen" })).status, 410);
  assert.equal(push.status().subscriptions.length, 1);
  const restored = new GlancePush(journal, { path, automatic: false });
  assert.throws(() => restored.register(registration), (e: any) => e.statusCode === 410);
  await restored.close();
  assert.equal((await post({ ...registration, max_length: 0, subscription_id: "invalid" })).status, 400);
  assert.equal((await post({ ...registration, operation: "unknown" })).status, 400);
  assert.equal((await fetch(url + "/api/glance/push", { headers: { Authorization: `Bearer ${credential}` } })).status, 403);
  assert.equal((await post({}, `Bearer ${credential}`, "/api/glance/push/test")).status, 403);
  const dry = await post({ subscription_id: "watcher-b", title: "Test", text: "OK", dry_run: true }, `Bearer ${control}`, "/api/glance/push/test");
  assert.equal(dry.status, 200); assert.equal((await dry.json() as any).contactedFirebase, false);
  // Old polling stays independent; registration consumed no completion.
  const poll = await post({ watcher: "Build alerts", max_length: 80, title_max_length: 32 });
  assert.equal(poll.status, 200);
});

test("push payload uses FID/data-only, preserves emoji at UTF-16 limits, and rejects oversize without truncation", () => {
  const small = { ...subscription, maxLength: 3, titleMaxLength: 2 };
  const payload = buildPushPayload(small, { title: "😀", text: "😀!" }, 30);
  assert.deepEqual(payload, { message: { fid: "phone-fid", data: { subscription_id: "watcher-a", title: "😀", text: "😀!" }, android: { priority: "HIGH", ttl: "30s" } } });
  assert.throws(() => buildPushPayload(small, { title: "😀!", text: "x" }, 30), /UTF-16/);
  assert.throws(() => buildPushPayload(small, { title: "x", text: "😀😀" }, 30), /UTF-16/);
  assert.throws(() => buildPushPayload(small, { title: " ", text: "x" }, 30), /nonempty/);
  assert.throws(() => buildPushPayload(small, { title: "x", text: "\uD800" }, 30), /Unicode/);
  assert.throws(() => buildPushPayload({ ...subscription, maxLength: 10_000 }, { title: "x", text: "中".repeat(1400) }, 30), /4096/);
  assert.equal(buildPushPayload(subscription, { title: "x", text: "y" }, 10, "NORMAL").message.android.priority, "NORMAL");
});

test("configured senders require the phone's matching Firebase project before changing a watcher", async t => {
  const { runtime, journal, path } = fixture(t);
  const push = new GlancePush(journal, { path, automatic: false, projectId: "my-glance-beta" });
  t.after(() => push.close());
  const bridge = createBridgeServer(runtime, journal, { token: control, notificationToken: credential, push });
  await new Promise<void>(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
  t.after(() => bridge.close());
  const address = bridge.server.address(); assert.ok(address && typeof address !== "string");
  const post = (data: unknown) => fetch(`http://127.0.0.1:${address.port}/api/glance`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` }, body: JSON.stringify(data),
  });
  assert.equal((await post({ ...registration, firebase_project_id: "my-glance-beta" })).status, 204);
  const unchanged = readFileSync(path, "utf8");
  for (const [project, expected] of [[undefined, 400], ["invalid/project", 400], ["even-glance", 409]] as const) {
    const response = await post({ ...registration, firebase_project_id: project, installation_id: "credential-must-not-be-reflected" });
    assert.equal(response.status, expected);
    const body = await response.text(); assert.match(body, /firebase_project_id/); assert(!body.includes("credential-must-not-be-reflected"));
    assert.equal(readFileSync(path, "utf8"), unchanged);
  }
  const restored = new GlancePush(journal, { path, automatic: false, projectId: "my-glance-beta" });
  assert.equal(restored.status().subscriptions.length, 1); await restored.close();
  const unconfigured = new GlancePush(journal, { automatic: false });
  unconfigured.register({ ...registration, firebase_project_id: undefined });
  assert.equal(unconfigured.status().subscriptions.length, 1); await unconfigured.close();
});

test("only settled completion events trigger pushes; shared-device watchers each route once and restarts do not replay", async t => {
  const sent: FcmPayload[] = [];
  const { runtime, push, journal, path } = fixture(t, { send: async payload => { sent.push(payload); return { name: "projects/even-glance/messages/1" }; } });
  push.register(registration); push.register({ ...registration, subscription_id: "watcher-b" });
  runtime.store.dispatch({ type: "agent.started" });
  runtime.store.dispatch({ type: "assistant.completed", text: "Ready" });
  await push.drain(); assert.equal(sent.length, 0);
  completeSession(runtime.store); runtime.store.dispatch({ type: "agent.settled" });
  await push.drain(); assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(p => p.message.data.subscription_id).sort(), ["watcher-a", "watcher-b"]);
  assert.equal(sent[0].message.data.text, "Job complete · project");
  assert.ok(push.status().jobs.every(j => j.status === "accepted"));
  assert.equal(push.status().deliveryConfirmationSupported, false);
  const restarted = new GlancePush(journal, { path, automatic: false, sender: { send: async () => { throw new Error("must not resend"); } } });
  await restarted.drain(); assert.ok(restarted.status().jobs.every(j => j.status === "accepted")); await restarted.close();
  push.unregister({ subscription_id: "watcher-a" });
  runtime.store.dispatch({ type: "agent.started" });
  runtime.store.dispatch({ type: "runtime.exited", expected: false });
  await push.drain(); assert.equal(sent.length, 2);
  completeSession(runtime.store, "failed");
  await push.drain(); assert.equal(sent.length, 3); assert.match(sent[2].message.data.text, /^Job failed/);
});

test("bounded transient retries use the latest FID and reduced TTL; Retry-After beyond freshness expires", async t => {
  let now = 100_000; const sent: FcmPayload[] = [];
  const { push } = fixture(t, { send: async p => {
    sent.push(p); if (sent.length === 1) throw new FcmFailure("transient", "FCM_UNAVAILABLE", 12_000);
    return { name: "projects/even-glance/messages/2" };
  } }, () => now);
  push.register(registration); push.test({ subscription_id: "watcher-a", title: "Test", text: "Done" });
  await push.drain(); assert.equal(push.status().jobs[0].nextAttemptAt, 112_000);
  now = 111_000; await push.drain(); assert.equal(sent.length, 1);
  push.register({ ...registration, installation_id: "refreshed-fid" });
  now = 112_000; await push.drain(); assert.equal(sent.length, 2);
  assert.equal(sent[1].message.fid, "refreshed-fid"); assert.equal(sent[1].message.android.ttl, "18s");
  assert.equal(push.status().jobs[0].status, "accepted");
  const expired = fixture(t, { send: async () => { throw new FcmFailure("transient", "FCM_RATE_LIMITED", 60_000); } }, () => now).push;
  expired.register(registration); expired.test({ subscription_id: "watcher-a", title: "Test", text: "Done" });
  await expired.drain(); assert.equal(expired.status().jobs[0].status, "expired");
});

test("removal cancels queued retries and late in-flight results do not restore the watcher", async t => {
  let reject!: (e: Error) => void;
  const { push } = fixture(t, { send: async () => new Promise((_resolve, fail) => { reject = fail; }) });
  push.register(registration); push.test({ subscription_id: "watcher-a", title: "Test", text: "Done" });
  const work = push.drain(); push.unregister({ subscription_id: "watcher-a" });
  reject(new FcmFailure("transient", "FCM_UNAVAILABLE")); await work;
  assert.equal(push.status().jobs[0].status, "cancelled");
  assert.throws(() => push.register(registration), (e: any) => e.statusCode === 410);
});

test("invalid destinations disable only the rejected subscription, authorization blocks sends, and oversize never reaches FCM", async t => {
  const { push } = fixture(t, { send: async p => {
    if (p.message.data.subscription_id === "watcher-a") throw new FcmFailure("destination", "FCM_UNREGISTERED");
    return { name: "projects/even-glance/messages/ok" };
  } });
  push.register(registration); push.register({ ...registration, subscription_id: "watcher-b" });
  for (const id of ["watcher-a", "watcher-b"]) push.test({ subscription_id: id, title: "Test", text: "OK" });
  await push.drain();
  assert.equal(push.status().subscriptions.find(s => s.id === "watcher-a")!.disabled, "FCM_UNREGISTERED");
  assert.equal(push.status().subscriptions.find(s => s.id === "watcher-b")!.disabled, undefined);
  push.register({ ...registration, installation_id: "new-fid" });
  assert.equal(push.status().subscriptions.find(s => s.id === "watcher-a")!.disabled, undefined);
  const auth = fixture(t, { send: async () => { throw new FcmFailure("auth", "FCM_AUTHORIZATION_FAILED"); } }).push;
  auth.register(registration); auth.test({ subscription_id: "watcher-a", title: "Test", text: "OK" });
  await auth.drain(); assert.equal(auth.status().blocked, "FCM_AUTHORIZATION_FAILED");
  assert.throws(() => auth.test({ subscription_id: "watcher-a", title: "Test", text: "OK" }), (e: any) => e.statusCode === 503);
  assert.throws(() => push.test({ subscription_id: "watcher-b", title: "Test", text: "a".repeat(81) }), /UTF-16/);
});

test("a restart during send records uncertain and never retries an ambiguous accepted response", async t => {
  const { push, path, journal } = fixture(t);
  push.register(registration);
  const disk = JSON.parse(readFileSync(path, "utf8"));
  disk.jobs.push({ id: "interrupted-job", subscriptionId: "watcher-a", title: "Test", text: "OK", priority: "HIGH", createdAt: Date.now(),
    expiresAt: Date.now() + 30_000, nextAttemptAt: Date.now(), attempts: 1, status: "sending" });
  writeFileSync(path, JSON.stringify(disk));
  const restored = new GlancePush(journal, { path, automatic: false, sender: { send: async () => { throw new Error("must not send"); } } });
  await restored.drain(); assert.equal(restored.status().jobs[0].status, "uncertain"); await restored.close();
});

test("HTTP v1 sender authenticates exact project/FID payload and classifies sanitized errors", async () => {
  const payload = buildPushPayload(subscription, { title: "Test", text: "OK" }, 30);
  const sender = new FcmSender("my-glance-beta", (async (url: any, init: any) => {
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/my-glance-beta/messages:send");
    assert.equal(init.headers.Authorization, "Bearer test-oauth");
    assert.equal(init.redirect, "error"); assert.deepEqual(JSON.parse(init.body), payload);
    return new Response(JSON.stringify({ name: "projects/my-glance-beta/messages/test" }));
  }) as typeof fetch, async () => "test-oauth");
  assert.equal((await sender.send(payload, new AbortController().signal)).name, "projects/my-glance-beta/messages/test");
  for (const [status, code, expected] of [[404, "UNREGISTERED", "destination"], [403, "SENDER_ID_MISMATCH", "auth"], [503, "UNAVAILABLE", "transient"], [400, "INVALID_ARGUMENT", "permanent"]] as const) {
    const bad = new FcmSender("even-glance", (async () => new Response(JSON.stringify({ error: { message: "secret-token-do-not-log", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code }] } }), { status, headers: { "Retry-After": "15" } })) as typeof fetch, async () => "token");
    await assert.rejects(bad.send(payload, new AbortController().signal), (e: any) => e.kind === expected && !e.message.includes("secret-token") && (expected !== "transient" || e.retryAfterMs === 15_000));
  }
  const network = new FcmSender("even-glance", (async () => { throw new Error("raw credentials"); }) as typeof fetch, async () => "token");
  await assert.rejects(network.send(payload, new AbortController().signal), (e: any) => e.kind === "uncertain");
  const credentials = new FcmSender("even-glance", fetch, async () => { throw new Error("private-key"); });
  await assert.rejects(credentials.send(payload, new AbortController().signal), (e: any) => e.code === "FCM_CREDENTIALS_UNAVAILABLE" && !e.message.includes("private-key"));
});

test("Firebase project validation rejects malformed values before any authentication or request", () => {
  let calls = 0;
  for (const project of [undefined, null, "", "short", "UPPERCASE", "project/path", "project?token=secret", "project-name-", "a".repeat(64)]) {
    assert.throws(() => validateFirebaseProjectId(project), error => error instanceof Error && error.message === "Invalid Firebase project ID");
    assert.throws(() => new FcmSender(project as string, (async () => { calls++; return Response.json({}); }) as typeof fetch,
      async () => { calls++; return "token"; }), /Invalid Firebase project ID/);
  }
  assert.equal(validateFirebaseProjectId("my-glance-beta"), "my-glance-beta");
  assert.equal(calls, 0);
});

test("working-to-zero automatically queues once even with an open companion; idle, tools and session changes stay quiet", async t => {
  const runtime = new TestRuntime({ cwd: "C:\\project" });
  const journal = new NotificationJournal(runtime.store);
  let sent = 0;
  let resolveSent!: () => void;
  const received = new Promise<void>(resolve => { resolveSent = resolve; });
  const push = new GlancePush(journal, { sender: { send: async () => { sent++; resolveSent(); return { name: "projects/even-glance/messages/auto" }; } } });
  t.after(async () => { await push.close(); journal.close(); });
  push.register(registration);
  runtime.store.dispatch({ type: "runtime.connected" });
  runtime.store.dispatch({ type: "agent.settled" });
  runtime.store.dispatch({ type: "session.reset" });
  assert.equal(push.status().jobs.length, 0);
  runtime.store.dispatch({ type: "agent.started" });
  runtime.store.dispatch({ type: "tool.started", id: "tool", name: "read" });
  runtime.store.dispatch({ type: "tool.finished", id: "tool", failed: false });
  runtime.store.dispatch({ type: "assistant.completed", text: "Done" });
  assert.equal(push.status().jobs.length, 0);
  runtime.store.dispatch({ type: "agent.settled" });
  completeSession(runtime.store);
  const timeout = setTimeout(() => resolveSent(), 1000);
  await received; clearTimeout(timeout);
  await push.drain(); assert.equal(sent, 1);
  runtime.store.dispatch({ type: "agent.settled" });
  runtime.store.dispatch({ type: "runtime.connected" });
  await push.drain(); assert.equal(sent, 1);
});

test("automatic completion content fits long Unicode session names and each watcher's small limits", async t => {
  const sent: FcmPayload[] = [];
  const { runtime, push } = fixture(t, { send: async payload => { sent.push(payload); return { name: "projects/test/messages/1" }; } });
  for (const max of [1, 4, 80, 10_000]) push.register({ ...registration, subscription_id: `watcher-${max}`, max_length: max, title_max_length: max === 1 ? 1 : 4 });
  runtime.store.publish(runtime.store.state, { type: "monitoring.settled", sessionId: "abcdef12-rest", session: "中文😀".repeat(1000), outcome: "completed" });
  await push.drain(); assert.equal(sent.length, 4);
  for (const payload of sent) {
    const max = Number(payload.message.data.subscription_id.slice(8));
    assert.ok(payload.message.data.text.length <= max);
    assert.ok(payload.message.data.title.length <= (max === 1 ? 1 : 4));
    assert.equal(Buffer.from(payload.message.data.text).toString(), payload.message.data.text);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 4096);
  }
  assert.match(sent.find(p => p.message.data.subscription_id === "watcher-80")!.message.data.text, /Job complete.*#abcdef12/);
  assert.ok(push.status().jobs.every(job => job.status === "accepted"));
  // Explicit caller-provided payloads are still rejected, never silently rewritten.
  assert.throws(() => push.test({ subscription_id: "watcher-4", title: "Too long", text: "too long", dry_run: true }), /length limit/);
});

test("auth delays cannot extend message freshness and transient auth errors do not become permanent failures", async () => {
  const payload = buildPushPayload(subscription, { title: "Test", text: "OK" }, 30);
  let calls = 0;
  const sender = new FcmSender("even-glance", (async () => { calls++; return new Response(); }) as typeof fetch, async () => "token");
  await assert.rejects(sender.send(payload, new AbortController().signal, Date.now() - 1), (e: any) => e.code === "CONTENT_EXPIRED");
  assert.equal(calls, 0);
  const unavailable = new FcmSender("even-glance", fetch, async () => { throw { response: { status: 503 } }; });
  await assert.rejects(unavailable.send(payload, new AbortController().signal), (e: any) => e.kind === "transient");
});
