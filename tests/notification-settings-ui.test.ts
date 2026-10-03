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
  onclick?: () => void; onchange?: () => void; oninput?: () => void;
  select = false;
  children: (Element | OptionElement)[] = [];
  private selected = "";
  private selectors = new Map<string, Element>();
  private listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
  selects?: Element[];
  get options() { return this.children.filter((child): child is OptionElement => child instanceof OptionElement); }
  get selectedOptions() { return this.options.filter(option => option.value === this.value); }
  get value() { return this.select && !this.options.some(option => option.value === this.selected) ? "" : this.selected; }
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
  addEventListener(name: string, callback: (event?: { preventDefault(): void }) => void) { this.listeners.set(name, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
  cancel() {
    let prevented = false;
    this.listeners.get("cancel")?.({ preventDefault: () => { prevented = true; } });
    if (!prevented) this.close();
    return prevented;
  }
}
function dom(t: TestContext) {
  const previous = ["document", "Option"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const dialog = new Element(); dialog.selects = [new Element(), new Element(), new Element()];
  for (const select of dialog.selects) select.select = true;
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

test("phone notification settings stay read-only until Save and can preview saved computers", async t => {
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

const center = "http://100.64.0.99:4317", centerKey = "one-time-center-control-key-123456789", relayKey = "r".repeat(43);
const savedRelay = { ...direct, mode: "relay", target: { id: "center-id", name: "center-server", url: center }, queued: 3 };
function desktop(t: TestContext, route: any = direct, intercept?: (path: string, data?: unknown) => Promise<any>) {
  const dialog = dom(t), calls: { url: string; path: string; data?: any }[] = [], network: { url: string; init?: RequestInit }[] = [];
  const requestFrom = async (url: string, path: string, data?: unknown) => {
    calls.push({ url, path, data });
    if (intercept) { const answer = await intercept(path, data); if (answer !== undefined) return answer; }
    if (path === "/api/pairing") return { registrationUrl: "http://100.64.0.1:4317/api/glance" };
    if (path === "/api/host") return { id: "local-id", name: "laptop" };
    if (path.endsWith("/push")) return { subscriptions: [] };
    return route;
  };
  const client = { activeUrl: () => remote, hosts: () => hosts, requestFrom,
    add: () => assert.fail("A notification center must never become a saved session connection") };
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    network.push({ url: String(url), init });
    return Response.json({ id: "center-id", name: "center-server", key: relayKey });
  });
  const settings = new NotificationSettings(() => client as any, local);
  return { dialog, client, settings, calls, network,
    url: dialog.querySelector("[data-notification-center-url]"), key: dialog.querySelector("[data-notification-center-key]"),
    save: dialog.querySelector(".primary"), status: dialog.querySelector('[role="status"]'),
    forwarding: () => { dialog.selects![1].value = "relay"; dialog.selects![1].onchange?.(); } };
}

test("desktop pins this computer, hides source/center selectors, and starts with no center URL", async t => {
  const f = desktop(t);
  f.settings.open(remote); await nextTurn();
  assert.equal(f.dialog.selects![0].value, local); assert.equal(f.dialog.selects![0].disabled, true);
  assert.equal(f.dialog.querySelector("[data-notification-source]").hidden, true);
  assert.equal(f.dialog.querySelector("[data-notification-caption]").textContent, "Notifications for this computer.");
  assert.equal(f.dialog.querySelector("[data-glance-registration]").textContent, "http://100.64.0.1:4317/api/glance");
  f.forwarding();
  assert.equal(f.dialog.querySelector("[data-notification-destination]").hidden, true);
  assert.equal(f.dialog.querySelector("[data-notification-center]").hidden, false);
  assert.equal(f.url.value, ""); assert.equal(f.key.value, "");
  f.dialog.selects![0].value = remote; f.dialog.selects![0].onchange?.(); await nextTurn();
  assert.equal(f.network.length, 0);
  assert(f.calls.every(call => call.url === local && call.data === undefined));
  assert.deepEqual(f.calls.map(call => call.path), ["/api/glance/routing", "/api/glance/push", "/api/pairing"]);
});

test("desktop registers an unsaved center only on Save using a transient authenticated request", async t => {
  const f = desktop(t);
  f.settings.open(); await nextTurn(); f.calls.length = 0;
  f.forwarding(); f.url.value = center + "/"; f.key.value = centerKey; f.url.oninput?.();
  f.dialog.selects![0].value = remote;
  assert.equal(f.network.length, 0, "Typing a center neither connects nor registers it");
  assert.equal(f.dialog.querySelector("[data-glance-registration]").textContent, center + "/api/glance");
  f.save.onclick?.(); await nextTurn();
  assert.equal(f.network.length, 1); assert.equal(f.network[0].url, center + "/api/glance/relay/register");
  assert.equal(f.network[0].init?.method, "POST"); assert.equal(f.network[0].init?.redirect, "error");
  assert.equal(f.network[0].init?.credentials, "omit");
  assert.equal(new Headers(f.network[0].init?.headers).get("authorization"), "Bearer " + centerKey);
  assert.deepEqual(JSON.parse(String(f.network[0].init?.body)), { sourceId: "local-id", sourceName: "laptop" });
  assert.deepEqual(f.calls.slice(0, 2), [
    { url: local, path: "/api/host", data: undefined },
    { url: local, path: "/api/glance/routing", data: { mode: "relay", target: { id: "center-id", name: "center-server", key: relayKey, url: center } } },
  ]);
  assert(f.calls.every(call => call.url === local), "The center is never requested through Fleet");
  assert.equal(f.key.value, "", "Successful registration clears the one-time control key");
  for (const selector of ['[role="status"]', "[data-glance-registration]", "[data-notification-instructions]"])
    assert(!f.dialog.querySelector(selector).textContent.includes(relayKey) && !f.dialog.querySelector(selector).textContent.includes(centerKey));
});

test("an existing desktop center survives without its control key or a key rotation", async t => {
  const f = desktop(t, savedRelay);
  f.settings.open(); await nextTurn();
  assert.equal(f.url.value, center); assert.equal(f.key.value, "");
  assert.match(f.status.textContent, /center-server · 3 queued/);
  f.calls.length = 0; f.save.onclick?.(); await nextTurn();
  assert.equal(f.network.length, 0); assert(f.calls.every(call => call.data === undefined && call.url === local));
  assert.equal(f.dialog.selects![1].value, "relay"); assert.equal(f.url.value, center);
  assert.match(f.status.textContent, /3 queued/, "Saving the unchanged center preserves queued notifications");
  f.key.value = centerKey; f.dialog.close(); assert.equal(f.key.value, "");
});

test("invalid center URLs, self-forwarding and short keys cannot send any settings", async t => {
  const f = desktop(t);
  f.settings.open(); await nextTurn(); f.calls.length = 0; f.forwarding();
  for (const url of ["file:///etc", center + "/api/glance", "http://user:secret@100.64.0.99:4317", center + "?token=secret", local + "/"]) {
    f.url.value = url; f.key.value = centerKey; f.save.onclick?.(); await nextTurn();
    assert.equal(f.calls.length, 0); assert.equal(f.network.length, 0);
  }
  f.url.value = center; f.key.value = "short"; f.save.onclick?.(); await nextTurn();
  assert.match(f.status.textContent, /at least 24/); assert.equal(f.calls.length, 0); assert.equal(f.network.length, 0);
});

test("failed center registration never changes the source route or automatically retries", async t => {
  const f = desktop(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Rejected" }, { status: 401 }));
  f.settings.open(); await nextTurn(); f.calls.length = 0;
  f.forwarding(); f.url.value = center; f.key.value = centerKey; f.save.onclick?.(); await nextTurn();
  assert.deepEqual(f.calls, [{ url: local, path: "/api/host", data: undefined }]);
  assert.match(f.status.textContent, /Could not confirm/); assert.equal(f.save.disabled, true);
  f.save.onclick?.(); await nextTurn(); assert.equal(f.calls.length, 1);
  f.dialog.close(); assert.equal(f.key.value, "");
});

test("Save blocks Close, Escape and reopen until a rotated relay key reaches the original source", async t => {
  const f = desktop(t, savedRelay);
  let resolve!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(done => { resolve = done; }));
  f.settings.open(); await nextTurn(); f.calls.length = 0;
  f.key.value = centerKey; f.save.onclick?.(); await nextTurn();
  assert.equal(typeof resolve, "function");
  const close = f.dialog.querySelector('[aria-label="Close notifications"]');
  assert.equal(close.disabled, true); close.onclick?.(); assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.cancel(), true, "Native Escape cancellation is prevented while the two-step Save is pending");
  f.settings.open(remote); await nextTurn();
  assert.equal(f.calls.length, 1, "Reopening cannot replace the captured operation with a new settings read");
  resolve(Response.json({ id: "center-id", name: "center-server", key: relayKey })); await nextTurn();
  assert.deepEqual(f.calls.filter(call => call.data !== undefined), [{ url: local, path: "/api/glance/routing",
    data: { mode: "relay", target: { id: "center-id", name: "center-server", key: relayKey, url: center } } }]);
  assert.equal(f.dialog.selects![1].value, "relay"); assert.equal(f.key.value, "");
  assert.equal(close.disabled, false); close.onclick?.(); assert.equal(f.dialog.open, false);
});

test("a programmatic close lets an authorized rotation finish without reopening the dialog", async t => {
  const f = desktop(t, savedRelay);
  let resolve!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(done => { resolve = done; }));
  f.settings.open(); await nextTurn(); f.calls.length = 0;
  f.key.value = centerKey; f.save.onclick?.(); await nextTurn();
  f.dialog.close(); assert.equal(f.key.value, "");
  f.settings.open(remote); await nextTurn(); assert.equal(f.dialog.open, false);
  resolve(Response.json({ id: "center-id", name: "center-server", key: relayKey })); await nextTurn();
  assert.deepEqual(f.calls.filter(call => call.data !== undefined), [{ url: local, path: "/api/glance/routing",
    data: { mode: "relay", target: { id: "center-id", name: "center-server", key: relayKey, url: center } } }]);
  assert.equal(f.dialog.open, false, "Completing a captured Save does not reopen a closed dialog");
  f.settings.open(); await nextTurn(); assert.equal(f.dialog.open, true);
});

test("a stale route read cannot overwrite a reopened desktop dialog", async t => {
  let first = true, resolve!: (route: unknown) => void;
  const f = desktop(t, direct, async path => {
    if (path === "/api/glance/routing" && first) { first = false; return new Promise(done => { resolve = done; }); }
  });
  f.settings.open(); await nextTurn(); f.dialog.close(); f.settings.open(); await nextTurn();
  assert.equal(f.dialog.selects![1].value, "direct");
  resolve(savedRelay); await nextTurn();
  assert.equal(f.dialog.selects![1].value, "direct"); assert.equal(f.url.value, "");
  assert.match(f.status.textContent, /Saved: direct/);
});

test("desktop never falls back to a remote computer when this computer is offline", async t => {
  const f = desktop(t);
  f.client.hosts = () => [{ ...hosts[0], online: false }, hosts[1]];
  f.settings.open(remote); await nextTurn();
  assert.equal(f.save.disabled, true); assert.match(f.status.textContent, /offline.*retained/);
  f.save.onclick?.(); assert.equal(f.calls.length, 0); assert.equal(f.network.length, 0);
});
