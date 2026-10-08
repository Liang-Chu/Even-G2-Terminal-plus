import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SessionsPanel, type SessionSummary } from "../apps/evenhub/src/sessions/panel.js";
import type { BridgeApi } from "../apps/evenhub/src/bridge/client.js";
import { scopedKey } from "../apps/evenhub/src/bridge/fleet.js";
import { initialState, type HostSource, type RuntimeState, type Tunnel } from "../packages/cockpit-state/types.js";

class Element {
  private text = "";
  className = ""; id = ""; value = ""; type = ""; title = ""; placeholder = "";
  hidden = false; disabled = false; open = false; checked = false; required = false; maxLength = 0; selectedIndex = 0;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  children: Element[] = []; parentElement?: Element;
  onclick?: () => void; onchange?: () => void; oninput?: () => void; ontoggle?: () => void;
  onsubmit?: () => void;
  private listeners = new Map<string, () => void>();
  constructor(public tag: string) {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get options() { return this.children.filter(child => child.tag === "option"); }
  get isConnected() { return true; }
  append(...children: Element[]) {
    for (const child of children) { child.detach(); child.parentElement = this; this.children.push(child); }
  }
  prepend(...children: Element[]) {
    for (const child of children.reverse()) { child.detach(); child.parentElement = this; this.children.unshift(child); }
  }
  replaceChildren(...children: Element[]) { for (const child of this.children) child.parentElement = undefined; this.children = []; this.append(...children); }
  private detach() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
  focus() {}
  contains(value?: Element): boolean { return value === this || this.children.some(child => child.contains(value)); }
  closest(selector: string): Element | undefined { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  private matches(selector: string) {
    if (selector === "[hidden]") return this.hidden;
    return selector.startsWith(".") ? this.className.split(" ").includes(selector.slice(1)) : this.tag === selector;
  }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector: string) {
    const parts = selector.split(" ");
    return this.descendants().filter(child => {
      if (!child.matches(parts.at(-1)!)) return false;
      let ancestor = child.parentElement;
      for (let index = parts.length - 2; index >= 0; index--) {
        while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
}
class OptionElement extends Element {
  constructor(text: string, value: string) { super("option"); this.textContent = text; this.value = value; }
}
function dom(t: TestContext) {
  const previous = ["document", "Option"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const body = new Element("body");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body, activeElement: undefined, createElement: (tag: string) => new Element(tag) } });
  Object.defineProperty(globalThis, "Option", { configurable: true, value: OptionElement });
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
  } });
  return body;
}
const local = "http://127.0.0.1:4317", remote = "http://100.64.0.2:4317", nativeKey = "a".repeat(32);
const localKey = scopedKey(local, nativeKey), remoteKey = scopedKey(remote, nativeKey);
const hosts: HostSource[] = [
  { id: "local", url: local, name: "Laptop", nameSource: "hostname", online: true },
  { id: "remote", url: remote, name: "NUC", nameSource: "hostname", online: true },
];
function fixture(t: TestContext, tunnel: Tunnel = "codex") {
  const body = dom(t), calls: { owner: string; path: string; data?: unknown }[] = [], changed: string[] = [], busy: boolean[] = [];
  let computerHosts = structuredClone(hosts);
  const rows: SessionSummary[] = [
    { key: localKey, id: "same-native-id", name: "Same title", cwd: "/local", tunnel: "pi", source: hosts[0], runtimeStatus: "idle", live: true, monitored: true, updatedAt: 1 },
    { key: remoteKey, id: "same-native-id", name: "Same title", cwd: "/remote", tunnel, source: hosts[1], runtimeStatus: "offline", live: false, monitored: false, updatedAt: 2 },
  ];
  const pending: { owner: string; path: string; resolve: (value: unknown) => void }[] = [];
  let delayCatalog = false;
  const catalogs: { result: { sessions: SessionSummary[]; skipped: number }; resolve: (value: unknown) => void }[] = [];
  const clientFor = (owner: string): BridgeApi => ({ hosts: () => computerHosts, activeUrl: () => local, request: async (path, data) => {
    calls.push({ owner, path, data });
    assert.equal(data, undefined, "History browsing must never send a native mutation");
    if (path === "/api/sessions") {
      const result = { sessions: rows.flatMap(row => {
        const host = computerHosts.find(host => host.url === row.source?.url);
        return host ? [{ ...row, source: host }] : [];
      }), skipped: 0 };
      if (delayCatalog) { delayCatalog = false; return new Promise(resolve => catalogs.push({ result: structuredClone(result), resolve })); }
      return result;
    }
    assert.match(path, /^\/api\/sessions\/[^/]+\/history$/);
    return new Promise(resolve => pending.push({ owner, path, resolve }));
  } });
  let currentClient = clientFor("original");
  const panel = new SessionsPanel({ client: () => currentClient, changed: value => changed.push(value), busy: value => busy.push(value) });
  const dialog = body.querySelector("dialog")!;
  t.after(() => dialog.close());
  const state = (): RuntimeState => ({ ...initialState("/local"), connected: true, hosts: computerHosts,
    session: { key: localKey, id: "same-native-id", cwd: "/local", tunnel: "pi" }, nativeTerminals: true,
    monitoring: { watched: 1, running: 0, since: 1, sessions: [{ key: localKey, name: "Same title", cwd: "/local", source: computerHosts[0], status: "idle", monitored: true, current: true }] } });
  panel.update(state(), true); panel.open("browse");
  return { panel, dialog, calls, changed, busy, rows, state,
    setHosts: (value: HostSource[]) => { computerHosts = value; },
    switchClient: () => { currentClient = clientFor("replacement"); },
    delayNextCatalog: () => { delayCatalog = true; },
    completeCatalog: () => { const catalog = catalogs.shift(); assert(catalog); catalog.resolve(catalog.result); },
    complete: (owner: string, key: string, text: string) => {
      const path = `/api/sessions/${encodeURIComponent(key)}/history`, index = pending.findIndex(read => read.owner === owner && read.path === path);
      assert.notEqual(index, -1, "the requested history read must exist");
      pending.splice(index, 1)[0].resolve({ session: rows.find(row => row.key === key), messages: [{ role: "assistant", text }] });
    } };
}
function history(dialog: Element) { return dialog.querySelector(".session-history")!; }
function resume(dialog: Element) { return history(dialog).querySelector("button")!; }
function assertReadOnly(f: ReturnType<typeof fixture>) {
  assert(f.calls.every(call => call.data === undefined && (call.path === "/api/sessions" || call.path.endsWith("/history"))));
  assert.equal(f.changed.length, 0); assert.equal(f.busy.length, 0);
  assert.equal(f.rows[0].monitored, true); assert.equal(f.rows[1].monitored, false);
}

test("phone session browsing uses compact multi-device and single-status dropdowns without changing Watch", async t => {
  const f = fixture(t); await nextTurn();
  const deviceMenu = f.dialog.querySelector(".session-devices-dropdown")!, statusMenu = f.dialog.querySelector(".session-status-dropdown")!;
  const device = (key: string) => deviceMenu.querySelectorAll("input").find(input => input.dataset.device === key)!;
  const chooseDevice = (key: string, checked = true) => { const input = device(key); input.checked = checked; input.onchange?.(); };
  const chooseStatus = (scope: string) => { const input = statusMenu.querySelectorAll("input").find(input => input.dataset.scope === scope)!; input.checked = true; input.onchange?.(); };
  const keys = () => f.dialog.querySelectorAll(".session-row").map(button => button.dataset.focusKey);
  assert.equal(deviceMenu.tag, "details"); assert.equal(statusMenu.tag, "details");
  assert.equal(deviceMenu.open, false); assert.equal(statusMenu.open, false);
  assert.equal(f.dialog.querySelector(".session-devices"), undefined); assert.equal(f.dialog.querySelector(".session-scopes"), undefined);
  assert.deepEqual(statusMenu.querySelectorAll("input").filter(input => input.checked).map(input => input.dataset.scope), ["all"]);
  const reads = f.calls.length;
  deviceMenu.open = true; chooseDevice(remote);
  assert.deepEqual(keys(), [remoteKey]);
  chooseDevice(local); assert.deepEqual(new Set(keys()), new Set([localKey, remoteKey]));
  assert.equal(deviceMenu.open, true); assert.equal(deviceMenu.querySelector("summary")!.textContent, "2 devices");
  chooseStatus("watched"); assert.deepEqual(keys(), [localKey]);
  chooseStatus("running"); assert.deepEqual(keys(), []);
  chooseStatus("all"); chooseDevice(local, false); assert.deepEqual(keys(), [remoteKey]);
  chooseDevice(remote, false); assert.equal(device("").checked, true);
  assert.deepEqual(new Set(keys()), new Set([localKey, remoteKey]));
  chooseDevice(remote); chooseDevice(""); assert.equal(device("").checked, true);
  assert.equal(deviceMenu.querySelector("summary")!.textContent, "All devices");
  assert.equal(f.calls.length, reads, "filters change the cached view without requests");
  assertReadOnly(f);
});

for (const tunnel of ["pi", "codex", "claude"] as const) {
  test(`${tunnel} saved history reads the remote scoped session without changing selection or Watch`, async t => {
    const f = fixture(t, tunnel); await nextTurn();
    f.panel.openHistory(f.rows[1]);
    assert.equal(resume(f.dialog).disabled, true, "Open stays disabled until history is read");
    f.complete("original", remoteKey, `${tunnel} remote conversation`); await nextTurn();
    assert.equal(history(f.dialog).querySelector("pre")!.textContent, `${tunnel} remote conversation`);
    assert.equal(resume(f.dialog).disabled, false, "matching native IDs across hosts do not mark remote history as current");
    assert(f.calls.some(call => call.path === `/api/sessions/${encodeURIComponent(remoteKey)}/history`));
    assertReadOnly(f);
  });
}

test("an offline remote host disables cached saved history actions and rejects its late response", async t => {
  const f = fixture(t); await nextTurn(); f.panel.openHistory(f.rows[1]);
  f.setHosts([hosts[0], { ...hosts[1], online: false }]); f.panel.update(f.state(), true);
  assert.equal(resume(f.dialog).disabled, true);
  const remoteHistory = f.dialog.querySelectorAll(".session-history-button").find(button => button.dataset.hostOffline === "true");
  assert(remoteHistory); assert.equal(remoteHistory.disabled, true, "unwatched saved rows use current host reachability");
  f.complete("original", remoteKey, "late remote content"); await nextTurn();
  assert.equal(history(f.dialog).querySelector("pre"), undefined);
  assert.match(history(f.dialog).textContent, /Reconnect this computer/);
  f.dialog.close(); f.panel.open("browse"); await nextTurn();
  assert.equal(resume(f.dialog).disabled, true);
  assertReadOnly(f);
});

test("removing a remote host invalidates pending history and clears the selection before reopening", async t => {
  const f = fixture(t); await nextTurn(); f.panel.openHistory(f.rows[1]); f.dialog.close();
  f.setHosts([hosts[0]]); f.panel.update(f.state(), true);
  f.complete("original", remoteKey, "removed computer conversation"); await nextTurn();
  f.panel.open("browse"); await nextTurn();
  assert.equal(history(f.dialog).querySelector("pre"), undefined);
  assert.equal(history(f.dialog).querySelector("button"), undefined);
  assert.match(history(f.dialog).textContent, /PICK UP WHERE YOU LEFT OFF/);
  assert(f.dialog.querySelectorAll(".session-row").every(button => button.dataset.focusKey === localKey));
  assertReadOnly(f);
});

test("history from a replaced requesting client is ignored and a fresh client can read the same scoped session", async t => {
  const f = fixture(t); await nextTurn(); f.panel.openHistory(f.rows[1]);
  f.switchClient(); f.panel.update(f.state(), true);
  f.complete("original", remoteKey, "old client conversation"); await nextTurn();
  assert.equal(history(f.dialog).querySelector("pre"), undefined); assert.equal(resume(f.dialog).disabled, true);
  f.panel.openHistory(f.rows[1]); f.complete("replacement", remoteKey, "current client conversation"); await nextTurn();
  assert.equal(history(f.dialog).querySelector("pre")!.textContent, "current client conversation");
  assert.equal(resume(f.dialog).disabled, false);
  assertReadOnly(f);
});

test("selecting local history rejects a late remote response even when native session IDs match", async t => {
  const f = fixture(t); await nextTurn();
  f.panel.openHistory(f.rows[1]); f.panel.openHistory(f.rows[0]);
  f.complete("original", localKey, "local conversation"); await nextTurn();
  f.complete("original", remoteKey, "late remote conversation"); await nextTurn();
  assert.equal(history(f.dialog).querySelector("pre")!.textContent, "local conversation");
  assert.equal(resume(f.dialog).textContent, "CURRENT SESSION"); assert.equal(resume(f.dialog).disabled, true);
  assertReadOnly(f);
});

test("a late online catalog cannot re-enable an unwatched session or pending history after its host goes offline", async t => {
  const f = fixture(t); await nextTurn(); f.panel.openHistory(f.rows[1]);
  f.delayNextCatalog(); f.panel.open("browse");
  f.setHosts([hosts[0], { ...hosts[1], online: false }]); f.panel.update(f.state(), true);
  f.completeCatalog(); await nextTurn();
  const remoteRow = f.dialog.querySelectorAll(".session-row").find(button => button.dataset.focusKey === remoteKey)!;
  assert.equal(remoteRow.disabled, true); assert.equal(remoteRow.dataset.hostOffline, "true");
  const remoteHistory = f.dialog.querySelectorAll(".session-history-button").find(button => button.dataset.hostOffline === "true")!;
  assert.equal(remoteHistory.disabled, true); assert.equal(resume(f.dialog).disabled, true);
  f.complete("original", remoteKey, "late remote history after catalog"); await nextTurn();
  assert.equal(history(f.dialog).querySelector("pre"), undefined);
  assert.match(history(f.dialog).textContent, /Reconnect this computer/);
  assertReadOnly(f);
});

test("a late catalog cannot resurrect a removed host's cached row or selected history", async t => {
  const f = fixture(t); await nextTurn(); f.panel.openHistory(f.rows[1]);
  f.delayNextCatalog(); f.panel.open("browse");
  f.setHosts([hosts[0]]); f.panel.update(f.state(), true);
  f.completeCatalog(); await nextTurn();
  assert.deepEqual(f.dialog.querySelectorAll(".session-row").map(button => button.dataset.focusKey), [localKey]);
  assert.equal(history(f.dialog).querySelector("button"), undefined);
  f.complete("original", remoteKey, "removed host history after catalog"); await nextTurn();
  assert.equal(history(f.dialog).querySelector("pre"), undefined);
  assert.match(history(f.dialog).textContent, /PICK UP WHERE YOU LEFT OFF/);
  assertReadOnly(f);
});
