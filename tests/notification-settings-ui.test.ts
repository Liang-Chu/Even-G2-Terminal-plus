import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { NotificationSettings } from "../apps/evenhub/src/notifications/settings.js";

const local = "http://127.0.0.1:4317", remote = "http://100.64.0.2:4317";
class OptionElement {
  constructor(public textContent: string, public value: string) {}
}
class Element {
  innerHTML = ""; textContent = ""; className = ""; type = ""; open = false; hidden = false; disabled = false;
  onclick?: () => void; onchange?: () => void;
  children: (Element | OptionElement)[] = [];
  private selected = "";
  private selectors = new Map<string, Element>();
  private listeners = new Map<string, () => void>();
  selects?: Element[];
  get options() { return this.children.filter((child): child is OptionElement => child instanceof OptionElement); }
  get selectedOptions() { return this.options.filter(option => option.value === this.value); }
  get value() { return this.options.some(option => option.value === this.selected) ? this.selected : ""; }
  set value(value: string) { this.selected = value; }
  querySelector(selector: string) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector)!;
  }
  querySelectorAll() { return this.selects!; }
  append(...children: (Element | OptionElement)[]) {
    this.children.push(...children); if (!this.value) this.selected = this.options[0]?.value || "";
  }
  replaceChildren(...children: (Element | OptionElement)[]) { this.children = []; this.selected = ""; this.append(...children); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
}
function dom(t: TestContext) {
  const previous = ["document", "Option"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const dialog = new Element(); dialog.selects = [new Element(), new Element(), new Element()];
  dialog.selects[1].replaceChildren(new OptionElement("Directly from this computer", "direct"), new OptionElement("Through a central computer", "relay"));
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => tag === "dialog" ? dialog : new Element(), body: { append() {} } } });
  Object.defineProperty(globalThis, "Option", { configurable: true, value: OptionElement });
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
  } });
  return dialog;
}
const hosts = [{ id: "local", name: "laptop", url: local, online: true }, { id: "remote", name: "nuc", url: remote, online: true }];
const direct = { mode: "direct", senderConfigured: true, queued: 0, sources: [] };

test("opening or previewing notification settings is read-only and desktop binds its own computer", async t => {
  const dialog = dom(t), calls: { url: string; path: string; data?: unknown }[] = [];
  let active = remote;
  const client = { activeUrl: () => active, hosts: () => hosts, requestFrom: async (url: string, path: string, data?: unknown) => {
    calls.push({ url, path, data }); return path.endsWith("/push") ? { subscriptions: [] } : direct;
  } };
  const settings = new NotificationSettings(() => client as any);
  settings.open(local); await nextTurn();
  assert.equal(dialog.selects![0].value, local);
  assert.equal(dialog.querySelector("[data-glance-registration]").textContent, local + "/api/glance");
  active = remote;
  dialog.selects![1].value = "relay"; dialog.selects![1].onchange?.();
  assert.equal(dialog.querySelector("[data-notification-destination]").hidden, false);
  assert.equal(dialog.querySelector("[data-glance-registration]").textContent, remote + "/api/glance");
  assert.match(dialog.querySelector("[data-notification-instructions]").textContent, /Only laptop forwards/);
  dialog.close(); await nextTurn();
  assert(calls.every(call => call.url === local && call.data === undefined));
  assert.deepEqual(calls.map(call => call.path), ["/api/glance/routing", "/api/glance/push"]);
});

test("saving central forwarding changes only the chosen source and registers the specified center", async t => {
  const dialog = dom(t), calls: { url: string; path: string; data?: any }[] = [];
  const relayKey = "synthetic-relay-key-not-for-display";
  const client = { activeUrl: () => local, hosts: () => hosts, requestFrom: async (url: string, path: string, data?: unknown) => {
    calls.push({ url, path, data });
    if (path === "/api/host") return { id: "local", name: "laptop" };
    if (path === "/api/glance/relay/register") return { id: "local", name: "laptop", key: relayKey };
    return path.endsWith("/push") ? { subscriptions: [] } : direct;
  } };
  new NotificationSettings(() => client as any).open(); await nextTurn(); calls.length = 0;
  dialog.selects![1].value = "relay"; dialog.selects![1].onchange?.();
  dialog.querySelector(".primary").onclick?.(); await nextTurn();
  assert.deepEqual(calls.slice(0, 3), [
    { url: local, path: "/api/host", data: undefined },
    { url: remote, path: "/api/glance/relay/register", data: { sourceId: "local", sourceName: "laptop" } },
    { url: local, path: "/api/glance/routing", data: { mode: "relay", target: { id: "local", name: "laptop", key: relayKey, url: remote } } },
  ]);
  for (const selector of ["[role=\"status\"]", "[data-glance-registration]", "[data-notification-instructions]"])
    assert(!dialog.querySelector(selector).textContent.includes(relayKey));
  dialog.selects![0].value = remote; dialog.selects![0].onchange?.(); await nextTurn(); calls.length = 0;
  dialog.querySelector(".primary").onclick?.(); await nextTurn();
  assert.deepEqual(calls[0], { url: remote, path: "/api/glance/routing", data: { mode: "direct" } });
});

test("offline and missing local computers never redirect notification settings to another host", async t => {
  const dialog = dom(t), calls: unknown[] = [];
  const client = { activeUrl: () => remote, hosts: () => [{ ...hosts[0], online: false }, hosts[1]], requestFrom: async (...args: unknown[]) => { calls.push(args); return direct; } };
  const settings = new NotificationSettings(() => client as any);
  settings.open(local); await nextTurn();
  assert.equal(dialog.querySelector(".primary").disabled, true);
  assert.match(dialog.querySelector('[role="status"]').textContent, /offline.*retained/);
  dialog.querySelector(".primary").onclick?.(); assert.equal(calls.length, 0);
  dialog.close(); settings.open("http://localhost:4317"); await nextTurn();
  assert.equal(dialog.selects![0].value, ""); assert.equal(calls.length, 0);
});

test("failed readback after saving does not re-enable controls with an unknown route", async t => {
  const dialog = dom(t); let saved = false;
  const client = { activeUrl: () => local, hosts: () => hosts, requestFrom: async (_url: string, path: string, data?: unknown) => {
    if (data !== undefined) { saved = true; return {}; }
    if (saved) throw new Error("network unavailable");
    return path.endsWith("/push") ? { subscriptions: [] } : direct;
  } };
  new NotificationSettings(() => client as any).open(); await nextTurn();
  dialog.querySelector(".primary").onclick?.(); await nextTurn();
  assert.equal(saved, true); assert.equal(dialog.querySelector(".primary").disabled, true);
  assert.equal(dialog.selects![0].disabled, false, "another computer can still be inspected");
  assert.match(dialog.querySelector('[role="status"]').textContent, /Could not load/);
});
