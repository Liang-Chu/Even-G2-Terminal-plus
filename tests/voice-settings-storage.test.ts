import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { VoiceSettings } from "../apps/evenhub/src/voice/settings.js";

const storageKey = "even-pilot.voice.v1";
const record = (key: string, updatedAt?: number) => JSON.stringify({
  ...(updatedAt === undefined ? {} : { version: 1, updatedAt }),
  provider: "whisper", language: "zh", openaiModel: "gpt-transcribe", keys: { whisper: key, elevenlabs: "" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class Element {
  innerHTML = ""; textContent = ""; className = ""; value = ""; hidden = false; open = false;
  onclick?: () => void; onchange?: () => void; onsubmit?: (event: { preventDefault(): void }) => void;
  private selectors = new Map<string, Element>();
  private listeners = new Map<string, () => void>();
  querySelector(selector: string) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector)!;
  }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
}
function fixture(t: TestContext, fallback?: string) {
  const previous = ["document", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const values = new Map<string, string>(), dialog = new Element();
  if (fallback) values.set(storageKey, fallback);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => dialog, body: { append() {} },
  } });
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  return { values, dialog, settings: new VoiceSettings(() => {}) };
}
function save(settings: VoiceSettings, dialog: Element, key: string) {
  settings.open(); dialog.querySelector("#voice-key").value = key;
  dialog.querySelector("form").onsubmit!({ preventDefault() {} });
}
function clear(settings: VoiceSettings, dialog: Element) {
  settings.open(); dialog.querySelector("[data-clear]").onclick!();
}

test("saved voice configuration loads before its settings DOM is requested", async () => {
  // No document exists in Node: mounting the dialog during startup would fail.
  const settings = new VoiceSettings(() => {});
  await settings.attachBridge({ getLocalStorage: async () => JSON.stringify({
    provider: "whisper", language: "zh", openaiModel: "gpt-transcribe", keys: { whisper: "fixture-key" },
  }), setLocalStorage: async () => true });
  assert.deepEqual(settings.config(), { provider: "whisper", language: "zh", openaiModel: "gpt-transcribe", key: "fixture-key" });
});

for (const scenario of [
  { name: "empty native storage", fallback: record("fallback", 20), native: "", wanted: "fallback" },
  { name: "older native storage", fallback: record("fallback", 20), native: record("native", 10), wanted: "fallback" },
  { name: "newer native storage", fallback: record("fallback", 10), native: record("native", 20), wanted: "native" },
  { name: "invalid native storage", fallback: record("fallback", 20), native: '{"version":99}', wanted: "fallback" },
  { name: "legacy fallback", fallback: record("legacy"), native: "", wanted: "legacy" },
]) test(`voice storage restores and acknowledges the freshest settings with ${scenario.name}`, async t => {
  const f = fixture(t, scenario.fallback), written: string[] = [];
  await f.settings.attachBridge({ getLocalStorage: async () => scenario.native,
    setLocalStorage: async (_key, value) => { written.push(value); return true; } });
  assert.equal(f.settings.config().key, scenario.wanted);
  assert.equal(written.length, 1);
  const stored = JSON.parse(written[0]);
  assert.equal(stored.keys.whisper, scenario.wanted); assert.equal(stored.version, 1); assert.ok(stored.updatedAt > 0);
  assert.equal(f.values.has(storageKey), false, "a successful native acknowledgement removes the duplicate browser key");
});

test("voice key saved before the bridge is ready survives an older native record", async t => {
  const f = fixture(t); save(f.settings, f.dialog, "newer-fixture"); await nextTurn();
  assert.ok(f.values.has(storageKey)); let stored = record("older-fixture");
  await f.settings.attachBridge({ getLocalStorage: async () => stored,
    setLocalStorage: async (_key, value) => { stored = value; return true; } });
  assert.equal(f.settings.config().key, "newer-fixture");
  assert.equal(JSON.parse(stored).keys.whisper, "newer-fixture"); assert.equal(f.values.has(storageKey), false);
});

test("a rejected native migration keeps the voice fallback until a later acknowledgement", async t => {
  const f = fixture(t, record("fallback-fixture", 20)); let accepted = false, stored = record("old-native", 10);
  const bridge = { getLocalStorage: async () => stored,
    setLocalStorage: async (_key: string, value: string) => { if (accepted) stored = value; return accepted; } };
  await f.settings.attachBridge(bridge);
  assert.equal(f.settings.config().key, "fallback-fixture");
  assert.equal(JSON.parse(f.values.get(storageKey)!).keys.whisper, "fallback-fixture");
  accepted = true; await f.settings.attachBridge(bridge);
  assert.equal(JSON.parse(stored).keys.whisper, "fallback-fixture"); assert.equal(f.values.has(storageKey), false);
});

for (const action of ["save", "clear"] as const) {
  test(`a delayed native voice read cannot replace a concurrent ${action}`, async t => {
    const f = fixture(t, record("original", 10)), read = deferred<string>();
    let stored = record("old-native", 5);
    const attaching = f.settings.attachBridge({ getLocalStorage: () => read.promise,
      setLocalStorage: async (_key, value) => { stored = value; return true; } });
    if (action === "save") save(f.settings, f.dialog, "current-fixture"); else clear(f.settings, f.dialog);
    await nextTurn(); read.resolve(record("old-native", 5)); await attaching;
    assert.equal(f.settings.config().key, action === "save" ? "current-fixture" : "");
    assert.equal(JSON.parse(stored).keys.whisper, f.settings.config().key);
  });

  test(`voice migration writes serialize behind a concurrent ${action} and cannot remove its fallback`, async t => {
    const f = fixture(t, record("original", 10)), first = deferred<boolean>(), latest = deferred<boolean>(), written: string[] = [];
    const attaching = f.settings.attachBridge({ getLocalStorage: async () => "",
      setLocalStorage: async (_key, value) => { written.push(value); return written.length === 1 ? first.promise : latest.promise; } });
    await nextTurn(); assert.equal(written.length, 1);
    if (action === "save") save(f.settings, f.dialog, "current-fixture"); else clear(f.settings, f.dialog);
    await nextTurn(); assert.equal(written.length, 1, "newer settings wait for the in-flight migration to finish");
    first.resolve(true); await attaching; await nextTurn();
    assert.equal(written.length, 2);
    assert.equal(JSON.parse(f.values.get(storageKey)!).keys.whisper, action === "save" ? "current-fixture" : "",
      "an old acknowledgement must not erase a pending Save/Clear fallback");
    latest.resolve(true); await nextTurn();
    assert.equal(JSON.parse(written[1]).keys.whisper, f.settings.config().key); assert.equal(f.values.has(storageKey), false);
  });
}

test("a replaced voice bridge cannot restore its late read or receive a migration", async t => {
  const f = fixture(t, record("fallback", 10)), read = deferred<string>(); let oldWrites = 0, newWrites = 0;
  const old = f.settings.attachBridge({ getLocalStorage: () => read.promise,
    setLocalStorage: async () => { oldWrites++; return true; } });
  await f.settings.attachBridge({ getLocalStorage: async () => record("current-native", 20),
    setLocalStorage: async () => { newWrites++; return true; } });
  read.resolve(record("stale-bridge", 30)); await old;
  assert.equal(f.settings.config().key, "current-native"); assert.equal(oldWrites, 0); assert.equal(newWrites, 1);
});

test("an old bridge acknowledgement cannot erase a replacement bridge's pending voice fallback", async t => {
  const f = fixture(t, record("fallback", 10)), oldWrite = deferred<boolean>(), newWrite = deferred<boolean>();
  const old = f.settings.attachBridge({ getLocalStorage: async () => "", setLocalStorage: () => oldWrite.promise });
  await nextTurn();
  const current = f.settings.attachBridge({ getLocalStorage: async () => record("current-native", 20), setLocalStorage: () => newWrite.promise });
  await nextTurn(); oldWrite.resolve(true); await old; await nextTurn();
  assert.equal(JSON.parse(f.values.get(storageKey)!).keys.whisper, "current-native");
  newWrite.resolve(true); await current;
  assert.equal(f.settings.config().key, "current-native"); assert.equal(f.values.has(storageKey), false);
});

for (const action of ["save", "clear"] as const) test(`failed native ${action} retains a retryable voice fallback without exposing keys`, async t => {
  const f = fixture(t); let stored = record("old-secret-fixture");
  const bridge = { getLocalStorage: async () => stored, setLocalStorage: async () => { throw new Error("old-secret-fixture"); } };
  await f.settings.attachBridge(bridge);
  if (action === "save") save(f.settings, f.dialog, "new-secret-fixture"); else clear(f.settings, f.dialog);
  await nextTurn();
  const expected = action === "save" ? "new-secret-fixture" : "";
  assert.equal(JSON.parse(f.values.get(storageKey)!).keys.whisper, expected);
  const status = f.dialog.querySelector("[data-status]").textContent;
  assert.match(status, /saved|removed/); assert.doesNotMatch(status, /secret-fixture/);
  const reopened = new VoiceSettings(() => {});
  await reopened.attachBridge({ getLocalStorage: async () => stored,
    setLocalStorage: async (_key, value) => { stored = value; return true; } });
  assert.equal(reopened.config().key, expected); assert.equal(JSON.parse(stored).keys.whisper, expected);
  assert.equal(f.values.has(storageKey), false);
});
