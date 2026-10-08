import test from "node:test";
import assert from "node:assert/strict";
import { BridgeClient, type ConnectionStatus } from "../apps/evenhub/src/bridge/client.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";

const key = "connection-fixture-key-1234567890123456789";
const flush = () => new Promise<void>(done => setImmediate(done));
test("Hub preflight accepts bearer-based pairing but never permits unauthenticated commands or wider token scope", async t => {
  const store = new CockpitStore("fixture"), journal = new NotificationJournal(store);
  const bridge = createBridgeServer({ store } as any, journal, { token: key, notificationToken: "notify-only-key-for-fixtures" });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  t.after(async () => { await bridge.close(); journal.close(); });
  const url = `http://127.0.0.1:${(bridge.server.address() as any).port}`;
  for (const origin of ["https://hub-build.example", "http://localhost:12345", "null"]) {
    const preflight = await fetch(url + "/api/events", { method: "OPTIONS", headers: { Origin: origin,
      "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,last-event-id" } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    const state = await fetch(url + "/api/state", { headers: { Origin: origin, Authorization: `Bearer ${key}` } });
    assert.equal(state.status, 200); assert.equal(state.headers.get("access-control-allow-origin"), origin);
    assert.equal((await fetch(url + "/api/prompt", { method: "POST", headers: { Origin: origin } })).status, 403);
    assert.equal((await fetch(url + "/api/state", { headers: { Origin: origin, Authorization: "Bearer notify-only-key-for-fixtures" } })).status, 403);
    assert.equal((await fetch(url + "/api/state?token=" + key, { headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await fetch(url + "/api/prompt", { method: "OPTIONS", headers: { Origin: "https://unknown.example",
    "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "authorization" } })).status, 403);
});
test("connection verification checks a real backend before saving and reports fetch failures without echoing its key", async t => {
  const state = new CockpitStore("fixture").state;
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, () => {}, () => {});
  const mock = t.mock.method(globalThis, "fetch", async (_url: any, options: any) => {
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    return Response.json(state);
  });
  assert.deepEqual(await client.verify(), state);
  mock.mock.mockImplementation(async () => Response.json({ error: "Check key" }, { status: 401 }));
  await assert.rejects(client.verify(), /Connection key rejected.*update this computer’s key/);
  mock.mock.mockImplementation(async () => Response.json({ unrelated: true }));
  await assert.rejects(client.verify(), /did not return a Terminal\+/);
  mock.mock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(client.verify(), error => { assert.match(String(error), /network whitelist/); assert.ok(!String(error).includes(key)); return true; });
});

test("a rejected stream reports a key repair action without echoing credentials", async t => {
  const errors: string[] = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: key }, { status: 401 }));
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, (_online, message) => { if (message) errors.push(message); }, () => {});
  t.after(() => client.disconnect()); client.connect(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1); assert.match(errors[0], /Connection key rejected.*Open Connection/);
  assert(!errors[0].includes(key));
});

test("a superseded stream cannot report old state or reconnecting after the new stream is online", async t => {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [], states: number[] = [], online: boolean[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } })));
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, state => states.push(state.revision), value => online.push(value), () => {});
  t.after(() => { client.disconnect(); for (const stream of streams) try { stream.close(); } catch {} });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  client.connect(); client.connect(); await tick(); assert.equal(streams.length, 1);
  client.reconnect(); await tick(); assert.equal(streams.length, 2);
  streams[0].enqueue(new TextEncoder().encode('event: state\ndata: {"revision":1}\n\n'));
  streams[1].enqueue(new TextEncoder().encode('event: state\ndata: {"revision":2}\n\n'));
  await tick();
  assert.deepEqual(states, [2]); assert.deepEqual(online, [false, true, false, true]);
});

test("invalid or oversized SSE releases its request before reconnecting", async t => {
  for (const payload of ['event: state\ndata: invalid-json\n\n', 'x'.repeat(2_000_001)]) {
    const statuses: boolean[] = []; let signal: AbortSignal | undefined;
    t.mock.method(globalThis, "fetch", async (_url: any, options: any) => {
      signal = options.signal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
      } }));
    });
    const client = new BridgeClient({ url: "http://127.0.0.1:4317", token: key }, () => {}, online => statuses.push(online), () => {});
    try {
      client.connect(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(signal?.aborted, true); assert.deepEqual(statuses, [false, true, false]);
    } finally { client.disconnect(); t.mock.restoreAll(); }
  }
});

test("one startup cycle attempts initially and retries five times at 30 seconds before remaining offline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts++; throw new TypeError("Failed to fetch"); });
  const statuses: ConnectionStatus[] = [];
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, (_online, _message, status) => { if (status) statuses.push(status); }, () => {});
  t.after(() => client.disconnect()); client.connect(); await flush();
  assert.equal(attempts, 1);
  assert.deepEqual(statuses.at(-1), { connectionState: "retrying", retryAttempt: 0 });
  for (let retry = 1; retry <= 5; retry++) {
    t.mock.timers.tick(29_999); await flush(); assert.equal(attempts, retry);
    t.mock.timers.tick(1); await flush(); assert.equal(attempts, retry + 1);
    assert.deepEqual(statuses.at(-1), { connectionState: retry === 5 ? "offline" : "retrying", retryAttempt: retry });
  }
  t.mock.timers.tick(10 * 60_000); await flush(); assert.equal(attempts, 6);
  client.resume(); client.connect(); client.disconnect(); client.resume();
  t.mock.timers.tick(10 * 60_000); await flush(); assert.equal(attempts, 6, "passive app lifecycle events cannot refresh an exhausted budget");
  client.reconnect(); await flush(); assert.equal(attempts, 7);
  assert.deepEqual(statuses.at(-1), { connectionState: "retrying", retryAttempt: 0 });
  t.mock.timers.tick(30_000); await flush(); assert.equal(attempts, 8);
  assert.equal(statuses.at(-1)?.retryAttempt, 1);
});

test("passive resume preserves a pending retry deadline instead of accelerating or restarting it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts++; throw new TypeError("Failed to fetch"); });
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, () => {}, () => {});
  t.after(() => client.disconnect()); client.connect(); await flush();
  t.mock.timers.tick(10_000); client.disconnect();
  t.mock.timers.tick(5000); client.resume(); await flush(); assert.equal(attempts, 1);
  t.mock.timers.tick(14_999); await flush(); assert.equal(attempts, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(attempts, 2);
});

test("successful streams retain the cycle's used retries when later disconnected", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [], statuses: ConnectionStatus[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } })));
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, (_online, _message, status) => { if (status) statuses.push(status); }, () => {});
  t.after(() => { client.disconnect(); for (const stream of streams) try { stream.close(); } catch {} });
  client.connect(); await flush();
  for (let retry = 0; retry <= 5; retry++) {
    assert.deepEqual(statuses.at(-1), { connectionState: "online", retryAttempt: retry });
    streams.at(-1)!.close(); await flush();
    if (retry < 5) { t.mock.timers.tick(30_000); await flush(); }
  }
  assert.equal(streams.length, 6);
  assert.deepEqual(statuses.at(-1), { connectionState: "offline", retryAttempt: 5 });
  t.mock.timers.tick(10 * 60_000); await flush(); assert.equal(streams.length, 6);
});

test("lifecycle suspension resumes a healthy fifth-retry stream once without refreshing its budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let attempts = 0;
  const streams: { controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }[] = [], statuses: ConnectionStatus[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, options: any) => {
    attempts++;
    if (attempts <= 5) throw new TypeError("Offline");
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push({ controller, signal: options.signal }); } }));
  });
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, (_online, _message, status) => { if (status) statuses.push(status); }, () => {});
  t.after(() => { client.disconnect(); for (const stream of streams) try { stream.controller.close(); } catch {} });
  client.connect(); await flush();
  for (let retry = 1; retry <= 5; retry++) { t.mock.timers.tick(30_000); await flush(); }
  assert.equal(attempts, 6); assert.deepEqual(statuses.at(-1), { connectionState: "online", retryAttempt: 5 });
  client.disconnect(); client.disconnect(); assert.equal(streams[0].signal.aborted, true);
  client.resume(); client.resume(); client.connect(); await flush();
  assert.equal(attempts, 7, "duplicate lifecycle events create only one resumed stream");
  assert.deepEqual(statuses.at(-1), { connectionState: "online", retryAttempt: 5 });
  streams.at(-1)!.controller.error(new TypeError("Offline again")); await flush();
  assert.deepEqual(statuses.at(-1), { connectionState: "offline", retryAttempt: 5 });
  client.disconnect(); client.resume(); t.mock.timers.tick(10 * 60_000); await flush();
  assert.equal(attempts, 7, "failure of the resumed stream exhausts the original budget");
});

test("manual reconnect clears a healthy suspension flag so later pending retries keep their deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [], statuses: ConnectionStatus[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } })));
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, (_online, _message, status) => { if (status) statuses.push(status); }, () => {});
  t.after(() => { client.disconnect(); for (const stream of streams) try { stream.close(); } catch {} });
  client.connect(); await flush(); client.disconnect(); client.disconnect(); client.reconnect(); await flush();
  assert.equal(streams.length, 2); assert.deepEqual(statuses.at(-1), { connectionState: "online", retryAttempt: 0 });
  streams.at(-1)!.error(new TypeError("Offline")); await flush();
  t.mock.timers.tick(10_000); client.disconnect(); client.disconnect();
  t.mock.timers.tick(5000); client.resume(); await flush(); assert.equal(streams.length, 2);
  t.mock.timers.tick(14_999); await flush(); assert.equal(streams.length, 2);
  t.mock.timers.tick(1); await flush();
  assert.equal(streams.length, 3); assert.deepEqual(statuses.at(-1), { connectionState: "online", retryAttempt: 1 });
});

test("401 stops automatic retries until a manual retry or repaired connection is supplied", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let attempts = 0;
  const statuses: ConnectionStatus[] = [], messages: string[] = [];
  t.mock.method(globalThis, "fetch", async () => { attempts++; return new Response(key, { status: 401 }); });
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, (_online, message, status) => {
    if (status) statuses.push(status); if (message) messages.push(message);
  }, () => {});
  t.after(() => client.disconnect()); client.connect(); await flush();
  assert.deepEqual(statuses.at(-1), { connectionState: "key-rejected", retryAttempt: 0 });
  assert(messages.every(message => !message.includes(key)));
  t.mock.timers.tick(10 * 60_000); client.disconnect(); client.resume(); await flush(); assert.equal(attempts, 1);
  client.reconnect(); await flush(); assert.equal(attempts, 2);
  t.mock.timers.tick(10 * 60_000); await flush(); assert.equal(attempts, 2);
});

test("a rejected authenticated request also stops its live stream and future automatic retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let stream!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal, attempts = 0;
  const statuses: ConnectionStatus[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, options: any) => {
    if (String(url).endsWith("/api/events")) {
      attempts++; signal = options.signal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
    }
    return new Response("Unauthorized", { status: 401 });
  });
  const client = new BridgeClient({ url: "http://100.64.0.2:4317", token: key }, () => {}, (_online, _message, status) => { if (status) statuses.push(status); }, () => {});
  t.after(() => { client.disconnect(); try { stream.close(); } catch {} });
  client.connect(); await flush();
  await assert.rejects(client.request("/api/state"), /Connection key rejected/);
  assert.equal(signal.aborted, true);
  assert.equal(statuses.at(-1)?.connectionState, "key-rejected");
  t.mock.timers.tick(10 * 60_000); await flush(); assert.equal(attempts, 1);
});
