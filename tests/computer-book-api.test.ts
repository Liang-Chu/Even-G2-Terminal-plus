import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerDirectory } from "../apps/windows/src/computers.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { TestRuntime } from "./fixtures/runtime.js";

const control = "fixture-control-computer-key-123456789", notify = "fixture-notify-computer-key-123456789";
test("shared computer APIs require the control key, portable CORS and backend readiness", async t => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-plus-computer-api-")), path = join(directory, "computers.json");
  const runtime = new TestRuntime({ cwd: directory }), journal = new NotificationJournal(runtime.store);
  const computers = new ComputerDirectory(path, () => ({ id: "host-owner", name: "Laptop", url: "http://100.64.0.1:4317", token: control }));
  let ready = false;
  const bridge = createBridgeServer(runtime, journal, { token: control, notificationToken: notify, computers, isReady: () => ready });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  t.after(async () => { await bridge.close(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}/api/computers`;
  const request = (token?: string, method = "GET", value?: unknown, origin?: string) => fetch(url, { method,
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(value !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(origin ? { Origin: origin } : {}) }, body: value !== undefined ? JSON.stringify(value) : undefined });
  assert.equal((await request()).status, 401);
  assert.equal((await request(notify)).status, 403);
  assert.equal((await request(control)).status, 503);
  ready = true;
  const initialRevision = runtime.store.state.revision;
  const allowed = await request(control, "GET", undefined, "http://127.0.0.1:34567");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Cache-Control"), "no-store");
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:34567");
  assert.equal(allowed.headers.get("Access-Control-Allow-Credentials"), null);
  const snapshot = await allowed.json();
  assert.equal(snapshot.entries[0].token, control);
  assert.equal(snapshot.owner.token, undefined);
  const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://paired.example", "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization, content-type" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://paired.example");
  assert.equal((await request(notify, "POST", { version: 1, entries: [] })).status, 403);
  assert.equal((await request(undefined, "GET", undefined, "https://unpaired.example")).status, 403);
  const entry = { id: "host-nuc", name: "NUC", url: "http://100.64.0.2:4317", token: "fixture-nuc-control-key-123456789",
    stamp: { counter: 1, writer: "browser-a" } };
  const merged = await request(control, "POST", { version: 1, entries: [entry] }, "https://paired.example");
  assert.equal(merged.status, 200); assert.equal((await merged.json()).entries.length, 2);
  assert.equal((await computers.snapshot()).entries.length, 2);
  assert.equal(new ComputerDirectory(path, () => ({ id: "host-owner", name: "Laptop", url: "http://100.64.0.1:4317", token: control })) instanceof ComputerDirectory, true);
  const before = readFileSync(path, "utf8");
  const invalid = await request(control, "POST", { version: 1, entries: [entry, { ...entry, id: "bad", url: "http://127.0.0.1:4317" }] });
  assert.equal(invalid.status, 400); assert.deepEqual(await invalid.json(), { error: "Invalid saved computer data" });
  assert.equal(readFileSync(path, "utf8"), before);
  const malformed = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + control, "Content-Type": "application/json" }, body: '{"token":"private-fixture"' });
  assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), { error: "Invalid saved computer data" });
  assert.equal(runtime.store.state.revision, initialRevision, "connection replication never alters live Watch or session state");
  assert.deepEqual(journal.list(), [], "connection replication never emits a notification");
});

test("old backends without a shared directory give a clear protected availability response", async t => {
  const runtime = new TestRuntime({ cwd: "fixture" }), journal = new NotificationJournal(runtime.store);
  const bridge = createBridgeServer(runtime, journal, { token: control, notificationToken: notify });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  t.after(async () => { await bridge.close(); journal.close(); });
  const url = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}/api/computers`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: "Bearer " + notify } })).status, 403);
  const response = await fetch(url, { headers: { Authorization: "Bearer " + control } });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /update this backend/);
});
