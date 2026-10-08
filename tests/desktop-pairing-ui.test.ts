import test from "node:test";
import assert from "node:assert/strict";
import { showPairing } from "../apps/evenhub/src/bridge/desktop-pairing.js";
import { pairingDetails } from "../apps/windows/src/pairing.js";

class Element {
  innerHTML = ""; textContent = ""; className = ""; value = ""; src = ""; open = false;
  focused = false; selected = false;
  onclick?: () => void;
  attributes = new Map<string, string>();
  children = new Map<string, Element>();
  listeners = new Map<string, () => void>();
  querySelector(selector: string) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector)!;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { if (name === "src") this.src = ""; this.attributes.delete(name); }
  addEventListener(name: string, handler: () => void) { this.listeners.set(name, handler); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}

test("desktop phone connection uses the supplied computer's pairing details without changing credentials", async t => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const dialog = new Element(), fields = new Map<string, Element>();
  const field = (id: string) => {
    if (!fields.has(id)) fields.set(id, new Element());
    return fields.get(id)!;
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => dialog, body: { append() {} }, getElementById: field,
  } });
  const copied: string[] = [];
  let denied = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: {
    async writeText(value: string) { if (denied) throw new Error("Clipboard unavailable"); copied.push(value); },
  } } });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete (globalThis as any).document;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator); else delete (globalThis as any).navigator;
  });
  const origin = "http://100.64.0.2:4317", key = "existing-computer-key-1234567890123456789";
  const pairing = pairingDetails(origin, key), calls: [string, unknown][] = [];
  const client = { request: async (path: string, data?: unknown) => { calls.push([path, data]); return pairing; } };
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

  await t.test("shows the phone-reachable URL, original key and shared QR", async () => {
    await showPairing(client);
    assert.equal(dialog.open, true);
    assert.equal(field("pairing-origin").value, origin);
    assert.equal(field("pairing-key").value, key);
    assert.equal(dialog.querySelector("img").src, pairing.image);
    assert.match(dialog.innerHTML, /Even Hub → Terminal\+ → Connection/);
    assert.doesNotMatch(dialog.innerHTML, /<form|Connect another computer|Firebase|notification mode/);
    assert.equal(dialog.attributes.get("aria-labelledby"), "pairing-title");
    assert.deepEqual(calls, [["/api/pairing", undefined]], "Viewing connection details only reads the paired computer");
  });

  await t.test("both compact copy controls copy their exact value, with a manual fallback", async () => {
    dialog.querySelector("[data-copy-url]").onclick?.(); await flush();
    dialog.querySelector("[data-copy-key]").onclick?.(); await flush();
    assert.deepEqual(copied, [origin, key]);
    denied = true;
    dialog.querySelector("[data-copy-key]").onclick?.(); await flush();
    assert.equal(field("pairing-key").focused, true); assert.equal(field("pairing-key").selected, true);
    assert.match(field("pairing-copy-status").textContent, /Ctrl\+C/);
  });

  await t.test("closing clears displayed credentials; reopening reads the same key", async () => {
    dialog.querySelector("button").onclick?.();
    assert.equal(dialog.open, false); assert.equal(field("pairing-key").value, "");
    assert.equal(dialog.querySelector("img").src, "");
    await showPairing(client);
    assert.equal(field("pairing-key").value, key); assert.equal(field("pairing-copy-status").textContent, "");
    dialog.close();
    await assert.rejects(showPairing({ request: async () => { throw new Error("Computer offline"); } }), /Computer offline/);
    assert.equal(dialog.open, false, "A failed connection read does not open an empty pairing panel");
    assert.equal(field("pairing-key").value, "");
    assert.ok(calls.every(([path, data]) => path === "/api/pairing" && data === undefined));
  });
});
