import test from "node:test";
import assert from "node:assert/strict";
import { UpdateSettings, updateComputer } from "../apps/evenhub/src/updates/settings.js";
import type { HostSource } from "../packages/cockpit-state/types.js";

const local = "http://127.0.0.1:4317", remote = "http://100.64.0.2:4317";
const hosts: HostSource[] = [
  { id: "local", name: "laptop", nameSource: "hostname", url: local, online: true },
  { id: "remote", name: "server", nameSource: "tailscale", url: remote, online: true },
];

test("desktop update target stays with the serving companion while a remote session is selected", () => {
  const client = { activeUrl: () => remote, hosts: () => hosts, requestFrom: async () => ({}) };
  assert.equal(updateComputer(client, local)?.url, local);
  assert.equal(updateComputer(client)?.url, remote, "Hub uses its current paired computer");
});

test("an offline or unsaved serving companion never redirects updates to another computer", () => {
  const client = { activeUrl: () => remote, hosts: () => [{ ...hosts[0], online: false }, hosts[1]], requestFrom: async () => ({}) };
  assert.equal(updateComputer(client, local)?.online, false);
  assert.equal(updateComputer(client, "http://localhost:4317"), undefined);
  assert.equal(updateComputer(undefined, local), undefined);
});

class Element {
  innerHTML = ""; textContent = ""; title = ""; className = "";
  disabled = false; hidden = false; checked = false; open = false;
  onclick?: () => void; onchange?: () => void;
  children = new Map<string, Element>();
  listeners = new Map<string, () => void>();
  classList = { toggle: () => {} };
  querySelector(selector: string) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector)!;
  }
  addEventListener(name: string, handler: () => void) { this.listeners.set(name, handler); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
}

const idle = { currentVersion: "1.1.5", automaticChecks: true, phase: "idle", progress: 0, installSupported: true,
  available: { version: "1.1.6", page: "https://example.test/release" } };
const flush = async () => { for (let n = 0; n < 4; n++) await Promise.resolve(); };
function fixture(t: any, request: (url: string, path: string, data?: unknown) => Promise<any>) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), dialog = new Element(), entry = new Element();
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    hidden: false, createElement: () => dialog, body: { append() {} }, addEventListener() {},
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else delete (globalThis as any).document; });
  let active = local;
  const notices: string[] = [], calls: { url: string; path: string; data?: unknown }[] = [];
  const client = { hosts: () => hosts, activeUrl: () => active, requestFrom: async (url: string, path: string, data?: unknown) => {
    calls.push({ url, path, data }); return request(url, path, data);
  } };
  const updates = new UpdateSettings(() => client, entry as any, undefined, message => notices.push(message));
  return { updates, dialog, entry, notices, calls, active: (value: string) => { active = value; },
    message: dialog.querySelector('[role="status"]'), check: dialog.querySelector(".outline"),
    automatic: dialog.querySelector("input"), install: dialog.querySelector(".primary") };
}

test("confirmed installation announces restart and closes the dialog without retrying installation", async t => {
  const f = fixture(t, async (_url, path) => path === "/api/updates/install" ? { ...idle, phase: "installing" } : idle);
  f.updates.open(); await flush(); assert.equal(f.dialog.open, true);
  f.install.onclick?.(); await flush();
  assert.equal(f.dialog.open, false); assert.match(f.notices[0], /will restart; reconnect afterward/);
  assert.equal(f.entry.textContent, "Restarting…");
  t.mock.timers.tick(60_000); await flush();
  assert.equal(f.calls.filter(call => call.path === "/api/updates/install").length, 1);
});

test("download polling retains progress until the backend confirms installation", async t => {
  let finish!: (value: any) => void, reads = 0;
  const f = fixture(t, async () => ++reads === 1 ? { ...idle, phase: "downloading", progress: 45 }
    : new Promise(done => { finish = done; }));
  f.updates.open(); await flush(); assert.equal(f.message.textContent, "Downloading 45%…");
  assert.equal(f.check.disabled, true); assert.equal(f.automatic.disabled, true); assert.equal(f.install.disabled, true);
  t.mock.timers.tick(3000); await flush();
  assert.equal(f.message.textContent, "Downloading 45%…", "A status poll does not flash Loading over progress");
  finish({ ...idle, phase: "installing" }); await flush(); assert.equal(f.dialog.open, false); assert.equal(f.notices.length, 1);
});

test("unavailable status is neutral and disables actions until a fresh status read", async t => {
  let offline = true;
  const f = fixture(t, async () => { if (offline) throw new Error("Failed to fetch"); return idle; });
  f.updates.open(); await flush(); assert.match(f.message.textContent, /Reconnecting/);
  assert.doesNotMatch(f.message.textContent, /backend needs|Installed|failed/i);
  assert.equal(f.check.disabled, true); assert.equal(f.automatic.disabled, true); assert.equal(f.install.disabled, true);
  f.check.onclick?.(); f.automatic.onchange?.(); f.install.onclick?.(); await flush();
  assert.equal(f.calls.length, 1, "Disconnected UI cannot send update actions");
  offline = false; t.mock.timers.tick(3000); await flush();
  assert.equal(f.check.disabled, false); assert.equal(f.automatic.disabled, false); assert.equal(f.install.disabled, false);
  assert.match(f.message.textContent, /Installed: 1\.1\.5/);
});

test("a lost installation acknowledgement only polls the same computer and requires fresh status", async t => {
  let reads = 0;
  const f = fixture(t, async (_url, path) => {
    if (path === "/api/updates/install") throw new Error("Connection closed after sending request");
    return ++reads === 1 ? idle : { ...idle, currentVersion: "1.1.6", available: undefined,
      lastResult: { status: "installed", version: "1.1.6" } };
  });
  f.updates.open(); await flush(); f.install.onclick?.(); await flush();
  assert.equal(f.dialog.open, true); assert.equal(f.notices.length, 0, "An unconfirmed request is not claimed as installation");
  assert.match(f.message.textContent, /not confirmed/); assert.equal(f.install.disabled, true);
  f.active(remote); f.install.onclick?.(); f.check.onclick?.(); await flush();
  t.mock.timers.tick(2000); await flush();
  assert.equal(f.calls.filter(call => call.path === "/api/updates/install").length, 1);
  assert.ok(f.calls.every(call => call.url === local)); assert.match(f.message.textContent, /Installed: 1\.1\.6/);
  assert.equal(f.check.disabled, false); assert.equal(f.install.hidden, true);
});

test("a stale installation response cannot close or notify a newly opened computer dialog", async t => {
  let finish!: (value: any) => void;
  const f = fixture(t, async (_url, path) => path === "/api/updates/install" ? new Promise(done => { finish = done; }) : idle);
  f.updates.open(); await flush(); f.install.onclick?.(); await flush();
  f.dialog.close(); f.active(remote); f.updates.open(); await flush();
  finish({ ...idle, phase: "installing" }); await flush();
  assert.equal(f.dialog.open, true); assert.equal(f.notices.length, 0);
  assert.equal(f.dialog.querySelector("[data-update-computer]").textContent, "Computer: server");
  assert.match(f.message.textContent, /Installed: 1\.1\.5/);
});

test("update dialog has no computer selector and pins actions until it is reopened", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), dialog = new Element();
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    hidden: false, createElement: () => dialog, body: { append() {} }, addEventListener() {},
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else delete (globalThis as any).document; });
  const calls: { url: string; path: string; data?: unknown }[] = [];
  let active = local;
  const client = { hosts: () => hosts, activeUrl: () => active, requestFrom: async (url: string, path: string, data?: unknown) => {
    calls.push({ url, path, data });
    return { currentVersion: "1.1.0", automaticChecks: true, phase: "idle", progress: 0, installSupported: true };
  } };
  const updates = new UpdateSettings(() => client, new Element() as any);
  updates.open(); await Promise.resolve();
  assert.doesNotMatch(dialog.innerHTML, /<select\b/);
  assert.equal(dialog.querySelector("[data-update-computer]").textContent, "Computer: laptop");
  active = remote;
  dialog.querySelector(".outline").onclick?.(); await Promise.resolve();
  const automatic = dialog.querySelector("input"); automatic.checked = false;
  automatic.onchange?.(); await Promise.resolve();
  assert(calls.every(call => call.url === local), "session changes cannot redirect open update controls");
  assert.deepEqual(calls.at(-1), { url: local, path: "/api/updates/settings", data: { automaticChecks: false } });
  dialog.close(); updates.open(); await Promise.resolve();
  assert.equal(calls.at(-1)?.url, remote, "Hub binds its new current computer on the next open");
});
