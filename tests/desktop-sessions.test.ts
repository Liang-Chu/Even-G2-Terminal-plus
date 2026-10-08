import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DesktopSessions } from "../apps/evenhub/src/sessions/desktop.js";
import { scopedKey } from "../apps/evenhub/src/bridge/fleet.js";
import type { BridgeApi } from "../apps/evenhub/src/bridge/client.js";
import { initialState, type HostSource, type RuntimeState } from "../packages/cockpit-state/types.js";
import type { SessionSummary } from "../apps/evenhub/src/sessions/panel.js";

class Element {
  textContent = ""; className = ""; value = ""; type = ""; placeholder = ""; title = "";
  checked = false; disabled = false; open = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  onclick?: () => void; onchange?: () => void; oninput?: () => void;
  constructor(public tag: string) {}
  get classList() { return { add: (value: string) => { this.className += " " + value; } }; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  focus() {}
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector: string) {
    return this.descendants().filter(child => selector.startsWith(".") ? child.className.split(" ").includes(selector.slice(1)) : child.tag === selector);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
}
function dom(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), workspace = new Element("div");
  let root!: Element;
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    hidden: false, createElement: (tag: string) => new Element(tag),
    querySelector: () => ({ before: (panel: Element) => { root = panel; workspace.append(panel); } }),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else delete (globalThis as any).document; });
  return () => root;
}
const local = "http://127.0.0.1:4317", remote = "http://100.64.0.2:4317", nativeKey = "a".repeat(32);
const localKey = scopedKey(local, nativeKey), remoteKey = scopedKey(remote, nativeKey), claudeKey = scopedKey(remote, "b".repeat(32));
const hosts: HostSource[] = [
  { id: "local", url: local, name: "Laptop", nameSource: "hostname", online: true },
  { id: "remote", url: remote, name: "NUC", nameSource: "hostname", online: true },
];
function fixture(t: TestContext, intercept?: (path: string, data?: unknown) => Promise<unknown>) {
  const root = dom(t), history: SessionSummary[] = [], notices: string[] = [], calls: { path: string; data?: any }[] = [];
  let computerHosts = structuredClone(hosts);
  const rows: SessionSummary[] = [
    { key: localKey, id: "same-native-id", name: "Same title", cwd: "/project", tunnel: "pi", model: "pi-model", source: hosts[0], updatedAt: 100, monitored: true, live: true, runtimeStatus: "idle" },
    { key: remoteKey, id: "same-native-id", name: "Same title", cwd: "/project", tunnel: "codex", model: "codex-model", source: hosts[1], updatedAt: 200, monitored: true, live: true, runtimeStatus: "running" },
    { key: claudeKey, id: "claude-id", name: "Claude notes", cwd: "/notes", tunnel: "claude", model: "claude-model", source: hosts[1], updatedAt: 300, monitored: false, live: false, runtimeStatus: "offline" },
  ];
  const state = (selected = localKey): RuntimeState => ({ ...initialState(), hosts: computerHosts, connected: true,
    session: { key: selected, id: "same-native-id", cwd: "/project" }, monitoring: { watched: rows.filter(row => row.monitored).length, running: 1, since: 1,
      sessions: rows.filter(row => (row.live || row.monitored) && computerHosts.some(host => host.url === row.source?.url)).map(row => ({ key: row.key, name: row.name || "Untitled session", cwd: row.cwd, tunnel: row.tunnel,
        model: row.model, source: computerHosts.find(host => host.url === row.source?.url), status: row.runtimeStatus,
        monitored: !!row.monitored, current: row.key === selected, updatedAt: row.updatedAt })) } });
  const client: BridgeApi = { hosts: () => computerHosts, request: async (path, data) => {
    calls.push({ path, data });
    if (intercept) { const result = await intercept(path, data); if (result !== undefined) return result; }
    if (path === "/api/sessions") return { sessions: structuredClone(rows) };
    if (path.endsWith("/monitor")) {
      const key = decodeURIComponent(path.split("/")[3]); rows.find(row => row.key === key)!.monitored = (data as any).monitored;
    }
    return state(path === "/api/session/resume" ? (data as any).key : localKey);
  } };
  let currentClient: BridgeApi = client;
  const panel = new DesktopSessions(() => currentClient, text => notices.push(text), () => {}, row => history.push(row));
  t.after(() => panel.close());
  panel.update(state());
  return { panel, root, calls, rows, history, notices, state,
    setHosts: (value: HostSource[]) => { computerHosts = value; }, setClient: (value: BridgeApi) => { currentClient = value; } };
}
function sessionRows(root: Element) { return root.querySelectorAll(".desktop-session-row"); }
function row(root: Element, key: string) { return sessionRows(root).find(row => row.dataset.sessionKey === key)!; }
function devices(root: Element) { return root.querySelector(".session-devices-dropdown")!; }
function device(root: Element, url: string) { return devices(root).querySelectorAll("input").find(input => input.dataset.device === url)!; }
function chooseDevice(root: Element, url: string, checked = true) { const input = device(root, url); input.checked = checked; input.onchange?.(); }
function setScope(root: Element, value: string) { const input = root.querySelector(".session-status-dropdown")!.querySelectorAll("input").find(input => input.dataset.scope === value)!; input.checked = true; input.onchange?.(); }

test("desktop combines all computers, keeps scoped identities, and filters Pi, Codex and Claude without commands", async t => {
  const f = fixture(t); await nextTurn(); const root = f.root();
  assert.equal(device(root, "").checked, true);
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [remoteKey, localKey]);
  assert.equal(row(root, localKey).className.includes("selected"), true);
  assert.equal(row(root, remoteKey).className.includes("selected"), false, "identical native IDs do not merge selected sessions");
  setScope(root, "all"); await nextTurn();
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [claudeKey, remoteKey, localKey]);
  const reads = f.calls.length; f.panel.showDevice(remote);
  assert.equal(f.calls.length, reads, "choosing a computer filter only changes the view");
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [claudeKey, remoteKey]);
  const search = root.querySelector(".desktop-session-toolbar")!.querySelectorAll("input").find(input => input.type === "search")!;
  search.value = "CLAUDE"; search.oninput?.();
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [claudeKey]);
  chooseDevice(root, ""); search.value = "pi-model"; search.oninput?.();
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [localKey]);
  search.value = "NUC"; search.oninput?.();
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [claudeKey, remoteKey]);
  assert(f.calls.every(call => call.path === "/api/sessions" && call.data === undefined), "browsing and filters never change Watch or open terminals");
});

test("desktop compact dropdowns combine multiple devices with one status and reset the final device to All", async t => {
  const f = fixture(t); await nextTurn(); const root = f.root();
  const status = root.querySelector(".session-status-dropdown")!;
  assert.equal(status.tag, "details"); assert.equal(devices(root).tag, "details");
  assert.equal(status.open, false); assert.equal(devices(root).open, false);
  assert.deepEqual(status.querySelectorAll("input").filter(input => input.checked).map(input => input.dataset.scope), ["watched"]);
  setScope(root, "all"); await nextTurn();
  devices(root).open = true; chooseDevice(root, remote); chooseDevice(root, local);
  assert.equal(devices(root).open, true, "the device menu stays open for multiple selections");
  assert.equal(device(root, "").checked, false); assert.equal(devices(root).querySelector("summary")!.textContent, "2 devices");
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [claudeKey, remoteKey, localKey]);
  chooseDevice(root, remote, false);
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [localKey]);
  chooseDevice(root, local, false);
  assert.equal(device(root, "").checked, true); assert.equal(devices(root).querySelector("summary")!.textContent, "All devices");
  status.open = true; setScope(root, "running");
  assert.equal(status.open, false, "choosing one status closes its menu");
  assert.deepEqual(status.querySelectorAll("input").filter(input => input.checked).map(input => input.dataset.scope), ["running"]);
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [remoteKey]);
  f.setHosts([hosts[0], { ...hosts[1], online: false }]); f.panel.update(f.state());
  assert.deepEqual(sessionRows(root), [], "Running excludes an offline host's cached runtime state");
  assert(f.calls.every(call => call.path === "/api/sessions" && call.data === undefined));
  assert.equal(f.rows.find(row => row.key === remoteKey)!.monitored, true);
});

test("device dropdown distinguishes retrying, exhausted offline and rejected keys", async t => {
  const f = fixture(t); await nextTurn(); const root = f.root(); f.panel.showDevice(remote);
  f.setHosts([hosts[0], { ...hosts[1], online: false, connectionState: "retrying", retryAttempt: 2 }]); f.panel.update(f.state());
  assert.match(devices(root).querySelector("summary")!.textContent, /retrying 2/);
  f.setHosts([hosts[0], { ...hosts[1], online: false, connectionState: "offline", retryAttempt: 5 }]); f.panel.update(f.state());
  assert.match(devices(root).querySelector("summary")!.textContent, /offline/);
  assert.doesNotMatch(devices(root).querySelector("summary")!.textContent, /retrying|reconnecting/i);
  f.setHosts([hosts[0], { ...hosts[1], online: false, connectionState: "key-rejected", retryAttempt: 1 }]); f.panel.update(f.state());
  assert.match(devices(root).querySelector("summary")!.textContent, /key rejected/);
});

test("History is read-only and Unwatch targets only the remote scoped key", async t => {
  const f = fixture(t); await nextTurn(); const root = f.root(); f.calls.length = 0;
  row(root, remoteKey).querySelector(".desktop-session-history")!.onclick?.();
  assert.deepEqual(f.history.map(session => session.key), [remoteKey]); assert.equal(f.calls.length, 0);
  const check = row(root, remoteKey).querySelector("input")!; check.checked = false; check.onchange?.(); await nextTurn();
  assert.deepEqual(f.calls.filter(call => call.data !== undefined), [{ path: `/api/runtime/${encodeURIComponent(remoteKey)}/monitor`, data: { monitored: false } }]);
  assert.equal(f.rows.find(row => row.key === localKey)!.monitored, true);
  assert.equal(f.rows.find(row => row.key === remoteKey)!.monitored, false);
  assert.match(f.notices.at(-1)!, /terminal and running task continue/);
  setScope(root, "all"); await nextTurn();
  row(root, remoteKey).querySelector(".desktop-row-actions")!.children[0].onclick?.(); await nextTurn();
  assert.deepEqual(f.calls.filter(call => call.path === "/api/session/resume"), [{ path: "/api/session/resume", data: { key: remoteKey } }]);
});

test("offline cached rows retain Watch, disable actions, reconnect and disappear immediately when removed", async t => {
  const f = fixture(t); await nextTurn(); const root = f.root(); setScope(root, "all"); await nextTurn();
  const oldRow = row(root, claudeKey), oldWatch = row(root, remoteKey).querySelector("input")!;
  f.calls.length = 0;
  f.setHosts([hosts[0], { ...hosts[1], online: false }]); f.panel.update(f.state());
  for (const key of [remoteKey, claudeKey]) {
    const current = row(root, key);
    assert(current.querySelectorAll("button").every(button => button.disabled));
    assert.equal(current.querySelector("input")!.disabled, true);
    assert.equal(current.querySelector(".session-badge")!.textContent, "HOST OFFLINE");
  }
  assert.equal(row(root, remoteKey).querySelector("input")!.checked, true);
  oldRow.querySelector(".desktop-session-history")!.onclick?.(); oldRow.querySelector(".desktop-row-actions")!.children[0].onclick?.();
  oldWatch.checked = false; oldWatch.onchange?.(); await nextTurn();
  assert.equal(f.history.length, 0); assert(f.calls.every(call => call.data === undefined), "stale handlers cannot command an offline host");
  f.setHosts(structuredClone(hosts)); f.panel.update(f.state());
  assert.equal(row(root, claudeKey).querySelector(".desktop-session-history")!.disabled, false);
  chooseDevice(root, remote);
  f.setHosts([hosts[0]]); f.panel.update(f.state());
  assert.deepEqual(sessionRows(root).map(row => row.dataset.sessionKey), [localKey]);
  assert.equal(device(root, "").checked, true);
  assert.equal(devices(root).querySelectorAll("input").some(input => input.dataset.device === remote), false);
  assert.equal(f.rows.find(row => row.key === remoteKey)!.monitored, true, "removing a viewer never changes remote Watch");
});

test("late catalogs cannot resurrect removed hosts or replace a different client", async t => {
  let resolve!: (value: unknown) => void;
  const f = fixture(t, path => path === "/api/sessions" ? new Promise(done => { resolve = done; }) : Promise.resolve(undefined));
  f.setHosts([hosts[0]]); f.panel.update(f.state());
  resolve({ sessions: structuredClone(f.rows) }); await nextTurn(); const root = f.root(); setScope(root, "all");
  assert.equal(sessionRows(root).some(row => row.dataset.sessionKey === remoteKey), false);
  await nextTurn();
  const replacement: BridgeApi = { hosts: () => [hosts[0]], request: async () => ({ sessions: [] }) };
  f.setClient(replacement); resolve({ sessions: [{ ...f.rows[0], name: "Stale old client" }] }); await nextTurn();
  assert.equal(row(root, localKey).querySelector("strong")!.textContent, "Same title");
  await f.panel.load();
  assert.equal(row(root, localKey).querySelector("strong")!.textContent, "Same title", "latest runtime membership remains authoritative over an empty catalog");
});

test("a late session action preserves newer selection and closed panels ignore in-flight loads", async t => {
  let completeAction!: (value: RuntimeState) => void;
  const f = fixture(t, (path, data) => data && path === "/api/session/resume" ? new Promise(done => { completeAction = done; }) : Promise.resolve(undefined));
  await nextTurn(); const root = f.root();
  row(root, remoteKey).querySelector(".desktop-row-actions")!.children[0].onclick?.();
  f.panel.update(f.state(localKey)); completeAction(f.state(remoteKey)); await nextTurn();
  assert.equal(row(root, localKey).className.includes("selected"), true);
  assert.equal(row(root, remoteKey).className.includes("selected"), false);
  let completeCatalog!: (value: unknown) => void;
  f.setClient({ hosts: () => hosts, request: async () => new Promise(done => { completeCatalog = done; }) });
  const load = f.panel.load(), before = sessionRows(root).map(row => row.querySelector("strong")!.textContent);
  f.panel.close(); completeCatalog({ sessions: [] }); await load;
  assert.deepEqual(sessionRows(root).map(row => row.querySelector("strong")!.textContent), before);
});
