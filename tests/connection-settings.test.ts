import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionSettings } from "../apps/evenhub/src/bridge/settings.js";

const value = { url: "http://100.64.0.2:4317", token: "synthetic-connection-key-123456789" };
const key = "even-pilot.connection.v1";
test("multiple computer keys survive Hub recreation; removing one never removes the other", async () => {
  const local = storage(), bridge = appStorage(), second = { url: "http://100.64.0.3:4317", token: "different-host-key-123456789012345" };
  const settings = new ConnectionSettings(() => local, () => storage());
  await settings.save(value); await settings.save(second); await settings.select(value.url);
  await settings.attachBridge(bridge);
  const restored = new ConnectionSettings(() => storage(), () => storage());
  await restored.attachBridge(bridge);
  assert.deepEqual(restored.all(), [value, second]); assert.deepEqual(restored.current(), value);
  await restored.remove(value.url);
  const reopened = new ConnectionSettings(() => storage(), () => storage()); await reopened.attachBridge(bridge);
  assert.deepEqual(reopened.all(), [second]); assert.deepEqual(reopened.current(), second);
});
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) || null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
function appStorage() {
  const local = storage();
  return { local, getLocalStorage: async (key: string) => local.getItem(key) || "",
    setLocalStorage: async (key: string, value: string) => { local.setItem(key, value); return true; } };
}

test("connection survives a fresh browser tab and a recreated Hub WebView without its browser storage", async () => {
  const local = storage(), session = storage(), bridge = appStorage();
  const first = new ConnectionSettings(() => local, () => session);
  assert.equal(await first.save(value), true);
  assert.deepEqual(new ConnectionSettings(() => local, () => storage()).current(), value);
  await first.attachBridge(bridge);
  assert.equal(local.data.size, 0, "native acknowledgement removes the fallback credential copy");
  const reopened = new ConnectionSettings(() => storage(), () => storage());
  assert.equal(reopened.current(), undefined);
  assert.deepEqual(await reopened.attachBridge(bridge), value);
});

test("late Hub reads cannot overwrite a new connection or resurrect a forgotten one", async () => {
  for (const forget of [false, true]) {
    const local = storage(), bridge = appStorage();
    let finish!: (raw: string) => void;
    bridge.getLocalStorage = () => new Promise(resolve => { finish = resolve; });
    const settings = new ConnectionSettings(() => local, () => storage());
    const read = settings.attachBridge(bridge);
    if (forget) await settings.clear(); else await settings.save(value);
    finish(JSON.stringify({ version: 1, updatedAt: Date.now() + 1000, connection: { ...value, url: "http://100.64.0.3:4317" } }));
    await read;
    assert.deepEqual(settings.current(), forget ? undefined : value);
    const next = new ConnectionSettings(() => storage(), () => storage());
    bridge.getLocalStorage = async key => bridge.local.getItem(key) || "";
    assert.deepEqual(await next.attachBridge(bridge), forget ? undefined : value);
  }
});

test("failed Hub writes retain browser fallback and a forget tombstone beats stale Hub data", async () => {
  const local = storage(), bridge = appStorage();
  const settings = new ConnectionSettings(() => local, () => storage());
  await settings.attachBridge(bridge); await settings.save(value);
  bridge.setLocalStorage = async () => false;
  assert.equal(await settings.clear(), true);
  const next = new ConnectionSettings(() => local, () => storage());
  assert.equal(await next.attachBridge(bridge), undefined);
  bridge.setLocalStorage = async (key, raw) => { bridge.local.setItem(key, raw); return true; };
  await next.attachBridge(bridge);
  assert.equal(JSON.parse(bridge.local.getItem(key)!).connection, null);
});

test("invalid saved endpoints are ignored and storage denial is reported without credentials", async () => {
  const local = storage();
  for (const url of ["file:///private", "http://user:pass@host/", "http://host/api/state", "http://host/?key=secret"]) {
    local.setItem(key, JSON.stringify({ version: 1, updatedAt: 1, connection: { ...value, url } }));
    assert.equal(new ConnectionSettings(() => local, () => storage()).current(), undefined);
  }
  const blocked = () => { throw new Error("Storage unavailable"); };
  const settings = new ConnectionSettings(blocked, blocked);
  assert.equal(await settings.save(value), false); assert.deepEqual(settings.current(), value);
});

test("the prior verified session-storage connection migrates to durable app storage", async () => {
  const local = storage(), session = storage(), bridge = appStorage();
  session.setItem("even-pilot.connection", JSON.stringify(value));
  const settings = new ConnectionSettings(() => local, () => session);
  assert.deepEqual(await settings.attachBridge(bridge), value);
  assert.equal(session.data.size, 0); assert.equal(local.data.size, 0);
});
