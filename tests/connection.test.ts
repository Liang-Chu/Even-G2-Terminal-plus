import test from "node:test";
import assert from "node:assert/strict";
import { BridgeClient } from "../apps/evenhub/src/bridge/client.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";

const key = "connection-fixture-key-1234567890123456789";
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
  assert.deepEqual(states, [2]); assert.deepEqual(online, [true, true]);
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
      assert.equal(signal?.aborted, true); assert.deepEqual(statuses, [true, false]);
    } finally { client.disconnect(); t.mock.restoreAll(); }
  }
});
