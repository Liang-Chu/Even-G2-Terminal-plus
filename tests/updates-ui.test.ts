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
