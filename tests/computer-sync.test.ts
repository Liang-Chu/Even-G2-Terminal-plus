import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { ComputerSync } from "../apps/evenhub/src/bridge/computers.js";
import { FleetClient } from "../apps/evenhub/src/bridge/fleet.js";
import { ConnectionSettings } from "../apps/evenhub/src/bridge/settings.js";
import { ConnectionActions } from "../apps/evenhub/src/bridge/connection-actions.js";
import { restoreViewerConnections } from "../apps/evenhub/src/bridge/restore.js";
import { mergeComputerBooks, nextComputerStamp, type ComputerBook } from "../packages/cockpit-state/computers.js";
import { initialState, type RuntimeState } from "../packages/cockpit-state/types.js";
import type { Connection } from "../apps/evenhub/src/bridge/client.js";

const a = "http://100.64.0.1:4317", b = "http://100.64.0.2:4317", c = "http://100.64.0.3:4317", local = "http://127.0.0.1:4317";
const key = (id: string) => `synthetic-${id}-connection-key-123456789012345`;
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (name: string) => data.get(name) || null,
    setItem: (name: string, value: string) => { data.set(name, value); }, removeItem: (name: string) => { data.delete(name); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
interface Backend { id: string; name: string; url: string; token: string; book: ComputerBook; supported: boolean; invalid?: boolean }
function network() {
  const backends = new Map<string, Backend>();
  for (const [id, url] of [["laptop", a], ["nuc", b], ["third", c]]) backends.set(url, {
    id, name: id, url, token: key(id), supported: true,
    book: { version: 1, entries: [{ id, name: id, url, token: key(id), stamp: { counter: 0, writer: id } }] },
  });
  backends.set(local, backends.get(a)!);
  const calls: { viewer: string; url: string; path: string; body?: unknown }[] = [];
  let intercept: ((viewer: string, connection: Connection, path: string, body: unknown) => Promise<unknown> | undefined) | undefined;
  async function request(viewer: string, connection: Connection, path: string, body?: unknown) {
    calls.push({ viewer, url: connection.url, path, body });
    const custom = intercept?.(viewer, connection, path, body);
    if (custom) { const value = await custom; if (value !== undefined) return value; }
    const backend = backends.get(connection.url); assert(backend);
    if (backend.token !== connection.token) throw new Error("Connection key rejected.");
    if (path === "/api/host") return { id: backend.id, name: backend.name, nameSource: "tailscale" };
    assert.equal(path, "/api/computers", "synchronization may use only connection metadata endpoints");
    if (!backend.supported) throw new Error("Bridge returned 404");
    if (backend.invalid) return { version: 1, entries: [{ token: "bad" }], owner: { id: backend.id, name: backend.name, url: backend.url } };
    if (body) backend.book = mergeComputerBooks(backend.book, body as ComputerBook);
    return structuredClone({ ...backend.book, owner: { id: backend.id, name: backend.name, url: backend.url } });
  }
  return { backends, calls, request, setIntercept: (value: typeof intercept) => { intercept = value; } };
}
async function viewer(t: TestContext, net: ReturnType<typeof network>, name: string, seeds: string[], servingOrigin?: string,
  cached?: ComputerBook, aliases: { id: string; url: string }[] = []) {
  const localStorage = storage(), settings = new ConnectionSettings(() => localStorage, () => storage());
  if (cached) await settings.saveComputerCache(cached, aliases);
  const endpoints = new Map<string, { connects: number; disconnects: number; reconnects: number; state: RuntimeState;
    offline: () => void; online: () => void }>();
  const fleet = new FleetClient(() => {}, () => {}, () => {}, () => {}, (connection, update, online) => {
    const state = initialState("/synthetic"); state.connected = true;
    const endpoint = { connects: 0, disconnects: 0, reconnects: 0, state,
      offline: () => online(false, "offline", { connectionState: "offline", retryAttempt: 5 }),
      online: () => online(true, undefined, { connectionState: "online", retryAttempt: 0 }) };
    endpoints.set(connection.url, endpoint);
    return {
      request: (path, body) => net.request(name, connection, path, body), verify: async () => state,
      connect: () => { endpoint.connects++; endpoint.online(); update(state); },
      disconnect: () => { endpoint.disconnects++; }, reconnect: () => { endpoint.reconnects++; endpoint.online(); },
      setViewedSession: () => {},
    };
  });
  const errors: string[] = [];
  const sync = new ComputerSync(() => fleet, settings, { servingOrigin, onError: value => errors.push(value) });
  t.after(() => { sync.close(); fleet.disconnect(); });
  const add = async (url: string, token = net.backends.get(url)!.token, replaceUrl?: string) => {
    const connection = { url, token }; await fleet.add(connection, false, false, () => true, replaceUrl); await settings.save(connection); await turn(); return connection;
  };
  for (const url of seeds) await add(url);
  return { fleet, settings, sync, endpoints, localStorage, errors, add };
}

test("two backends share computers with two viewers, discover a third transitively and avoid redundant writes", async t => {
  const net = network();
  net.backends.get(b)!.book = mergeComputerBooks(net.backends.get(b)!.book, net.backends.get(c)!.book);
  const desktop = await viewer(t, net, "desktop", [local, b], local);
  await desktop.sync.refresh(); await turn(); await desktop.sync.refresh();
  assert.deepEqual(new Set(desktop.fleet.connections().map(value => value.url)), new Set([local, b, c]));
  const phone = await viewer(t, net, "phone", [b]);
  await phone.sync.refresh(); await turn(); await phone.sync.refresh();
  assert.deepEqual(new Set(phone.fleet.connections().map(value => value.url)), new Set([a, b, c]));
  for (const backend of [net.backends.get(a)!, net.backends.get(b)!, net.backends.get(c)!])
    assert.deepEqual(backend.book.entries.map(entry => entry.id), ["laptop", "nuc", "third"]);
  const writes = net.calls.filter(call => call.body !== undefined).length;
  await phone.sync.refresh(); await desktop.sync.refresh();
  assert.equal(net.calls.filter(call => call.body !== undefined).length, writes);
  assert(net.calls.every(call => ["/api/host", "/api/computers"].includes(call.path)));
});

test("serving loopback stays local, shared addresses remain portable and a duplicate identity is removed", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [local], local);
  await f.sync.refresh(); await turn();
  assert.deepEqual(f.fleet.connections(), [{ url: local, token: key("laptop") }]);
  assert.equal(f.settings.computerBook().entries[0].deleted, undefined);
  assert.equal((f.settings.computerBook().entries[0] as any).url, a);
  assert(f.settings.computerAliases().some(alias => alias.url === local && alias.id === "laptop"));
  // A migrated cache may contain both aliases even though manual Fleet.add rejects duplicates.
  await f.fleet.add({ url: a, token: key("laptop") }, true, false); await turn();
  await f.sync.refresh();
  assert.deepEqual(f.fleet.connections(), [{ url: local, token: key("laptop") }]);
  assert.equal(f.endpoints.get(a)!.disconnects, 1);
  assert(net.calls.filter(call => call.body !== undefined).every(call => !JSON.stringify(call.body).includes("127.0.0.1")));
});

test("removal reaches peers before disconnect, erases keys from all caches and defeats stale browser/peer records", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b]);
  await f.sync.refresh();
  const stale = structuredClone(f.settings.computerBook());
  let propagatedBeforeDisconnect = false;
  net.setIntercept(async (_name, connection, path, body) => {
    if (connection.url !== b || path !== "/api/computers" || !body) return undefined;
    const backend = net.backends.get(b)!; backend.book = mergeComputerBooks(backend.book, body as ComputerBook);
    propagatedBeforeDisconnect = f.endpoints.get(b)!.disconnects === 0;
    return { ...backend.book, owner: { id: backend.id, name: backend.name, url: b } };
  });
  assert.equal(await f.sync.remove(b), true);
  assert(propagatedBeforeDisconnect);
  assert.deepEqual(f.fleet.connections().map(value => value.url), [a]);
  assert.equal(f.settings.computerBook().entries.find(entry => entry.id === "nuc")?.deleted, true);
  assert(!JSON.stringify(f.settings.computerBook()).includes(key("nuc")));
  assert(![...f.localStorage.data.values()].join("").includes(key("nuc")));
  net.setIntercept(undefined);
  net.backends.get(b)!.book = stale;
  const oldPhone = await viewer(t, net, "old-phone", [a, b], undefined, stale,
    [{ id: "laptop", url: a }, { id: "nuc", url: b }]);
  await oldPhone.sync.refresh();
  assert.deepEqual(oldPhone.fleet.connections().map(value => value.url), [a]);
  assert.equal(net.backends.get(b)!.book.entries.find(entry => entry.id === "nuc")?.deleted, true);
});

test("explicit Connect can re-add a tombstone and repair a changed key without stale replicas undoing it", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b]); await f.sync.refresh();
  await f.sync.remove(b);
  const deleted = structuredClone(f.settings.computerBook());
  net.backends.get(b)!.token = key("nuc-new");
  const connection = await f.add(b);
  assert.equal(await f.sync.connected(connection), true);
  const restored = f.settings.computerBook().entries.find(entry => entry.id === "nuc")!;
  assert.equal(restored.deleted, undefined); assert.equal((restored as any).token, key("nuc-new"));
  assert(restored.stamp.counter > deleted.entries.find(entry => entry.id === "nuc")!.stamp.counter);
  net.backends.get(a)!.book = mergeComputerBooks(net.backends.get(a)!.book, deleted);
  await f.sync.refresh();
  assert.equal(f.fleet.connections().find(value => value.url === b)!.token, key("nuc-new"));
  assert(!JSON.stringify(f.settings.computerBook()).includes(key("nuc") + '"'));
});

test("unavailable or unsupported metadata retains unknown offline legacy transports and exhausted retry budgets", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b]); await f.sync.refresh();
  const endpoint = f.endpoints.get(b)!; endpoint.offline();
  net.backends.get(a)!.supported = false;
  await f.sync.refresh(); await f.sync.refresh();
  assert.equal(f.endpoints.get(b), endpoint); assert.equal(endpoint.connects, 1); assert.equal(endpoint.disconnects, 0); assert.equal(endpoint.reconnects, 0);
  assert.equal(f.fleet.hosts().find(host => host.url === b)!.retryAttempt, 5);
  assert.deepEqual(f.fleet.connections().map(value => value.url), [a, b]);
  const unknown = await f.add(c); f.endpoints.get(c)!.offline();
  // Explicitly clear the fake transport's identity to model an unverified historical connection.
  const hosts = f.fleet.hosts.bind(f.fleet);
  t.mock.method(f.fleet, "hosts", () => hosts().map(host => host.url === c ? { ...host, id: "unknown", nameSource: "address" as const } : host));
  await f.sync.refresh();
  assert(f.fleet.connections().some(value => value.url === unknown.url));
});

test("invalid shared books cannot introduce endpoints or leak credential-shaped error details", async t => {
  const net = network(); net.backends.get(a)!.invalid = true;
  const f = await viewer(t, net, "desktop", [a]);
  await f.sync.refresh();
  assert.deepEqual(f.fleet.connections().map(value => value.url), [a]);
  assert(f.settings.computerBook().entries.every(entry => entry.id === "laptop"));
  assert(f.errors.every(error => !error.includes(key("laptop"))));
});

test("a late read cannot resurrect a removal, and suspend ignores late discoveries until resume", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b]); await f.sync.refresh();
  const wait = deferred<unknown>(), stale = structuredClone(net.backends.get(a)!.book);
  let waiting = true;
  net.setIntercept((_name, connection, path, body) => waiting && connection.url === a && path === "/api/computers" && !body ? wait.promise : undefined);
  const read = f.sync.refresh(); await turn();
  const remove = f.sync.remove(b);
  waiting = false; wait.resolve({ ...stale, owner: { id: "laptop", name: "laptop", url: a } });
  await read; assert.equal(await remove, true);
  assert.equal(f.settings.computerBook().entries.find(entry => entry.id === "nuc")!.deleted, true);
  assert(!f.fleet.connections().some(value => value.url === b));
  const late = deferred<unknown>();
  net.setIntercept((_name, connection, path, body) => connection.url === a && path === "/api/computers" && !body ? late.promise : undefined);
  const pending = f.sync.refresh(); await turn(); f.sync.suspend();
  late.resolve({ ...mergeComputerBooks(net.backends.get(a)!.book, net.backends.get(c)!.book), owner: { id: "laptop", name: "laptop", url: a } });
  await pending;
  assert(!f.fleet.connections().some(value => value.url === c));
  net.setIntercept(undefined); f.sync.resume(); await f.sync.refresh();
  assert(!f.fleet.connections().some(value => value.url === b));
});

test("a removed host's delayed write cannot add its newer response after a deliberate change", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b]); await f.sync.refresh();
  const late = deferred<unknown>(); let pendingWrite = true;
  // Make one peer need an update, then hold its write response.
  net.backends.get(b)!.book = { version: 1, entries: [net.backends.get(b)!.book.entries.find(entry => entry.id === "nuc")!] };
  net.setIntercept((_name, connection, path, body) => pendingWrite && connection.url === b && path === "/api/computers" && body ? late.promise : undefined);
  const old = f.sync.refresh(); await turn();
  const removal = f.sync.remove(b);
  pendingWrite = false;
  late.resolve({ ...mergeComputerBooks(net.backends.get(b)!.book, net.backends.get(c)!.book), owner: { id: "nuc", name: "nuc", url: b } });
  await old; assert.equal(await removal, true);
  assert(!f.fleet.connections().some(value => value.url === b || value.url === c));
});

test("a self tombstone does not disconnect the local serving portal or automatically republish it", async t => {
  const net = network(), backend = net.backends.get(a)!;
  backend.book = mergeComputerBooks(backend.book, { version: 1, entries: [{ id: "laptop", deleted: true,
    stamp: nextComputerStamp(backend.book, "other-viewer") }] });
  const f = await viewer(t, net, "desktop", [local], local);
  await f.sync.refresh();
  assert.deepEqual(f.fleet.connections(), [{ url: local, token: key("laptop") }]);
  assert.equal(f.settings.computerBook().entries[0].deleted, true);
  assert(!JSON.stringify(f.settings.computerBook()).includes(key("laptop")));
  assert(net.calls.every(call => call.body === undefined));
});

test("conversation notifications do not bypass the 15 second metadata interval", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a]);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  f.sync.start(); await turn(); await turn();
  const reads = () => net.calls.filter(call => call.path === "/api/computers" && call.body === undefined).length;
  const initial = reads(); assert(initial > 0);
  for (let update = 0; update < 30; update++) {
    f.sync.notify(); t.mock.timers.tick(200); await turn();
  }
  assert.equal(reads(), initial);
  t.mock.timers.tick(9000); await turn(); await turn();
  assert.equal(reads(), initial + 1);
});

test("resume starts synchronization when the app initially launched suspended", async t => {
  const net = network(), f = await viewer(t, net, "phone", [a]);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  f.sync.suspend(); f.sync.resume(); await turn(); await turn();
  const initial = net.calls.filter(call => call.path === "/api/computers").length; assert(initial > 0);
  t.mock.timers.tick(15_000); await turn(); await turn();
  assert(net.calls.filter(call => call.path === "/api/computers").length > initial);
});

test("a native settings cache attached after construction still supplies shared computers", async t => {
  const net = network(), f = await viewer(t, net, "phone", [a]);
  await f.settings.saveComputerCache(net.backends.get(c)!.book, [{ id: "third", url: c }]);
  await f.sync.refresh(); await turn(); await f.sync.refresh();
  assert.deepEqual(new Set(f.fleet.connections().map(value => value.url)), new Set([a, c]));
});

test("passive reads do not adopt a changed identity; explicit same-address repair tombstones the old identity", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b]); await f.sync.refresh();
  const backend = net.backends.get(b)!, oldIdentity = backend.id;
  backend.id = "zz-new-nuc"; backend.name = "new-nuc";
  backend.book = { version: 1, entries: [{ id: backend.id, name: backend.name, url: b,
    token: backend.token, stamp: { counter: 0, writer: backend.id } }] };
  net.backends.get(a)!.book = mergeComputerBooks(net.backends.get(a)!.book, net.backends.get(c)!.book);
  const writesBeforeMismatch = net.calls.filter(call => call.url === b && call.body !== undefined).length;
  const hosts = f.fleet.hosts.bind(f.fleet);
  const patch = t.mock.method(f.fleet, "hosts", () => hosts().map(host => host.url === b ? { ...host, id: backend.id, name: backend.name } : host));
  await f.sync.refresh();
  assert(!f.settings.computerBook().entries.some(entry => entry.id === backend.id));
  assert.equal(f.settings.computerAliases().find(alias => alias.url === b)!.id, oldIdentity);
  assert.equal(net.calls.filter(call => call.url === b && call.body !== undefined).length, writesBeforeMismatch,
    "a changed identity cannot receive the other computers' keys before explicit repair");
  patch.mock.restore();
  backend.token = key("new-nuc");
  const repaired = await f.add(b, backend.token);
  assert.equal(await f.sync.connected(repaired), true);
  assert.equal(f.settings.computerBook().entries.find(entry => entry.id === oldIdentity)!.deleted, true);
  const replacement = f.settings.computerBook().entries.find(entry => entry.id === backend.id)!;
  assert.equal(replacement.deleted, undefined); assert.equal((replacement as any).token, backend.token);
  assert.equal(f.fleet.connections().filter(value => value.url === b).length, 1);
  assert.equal(f.fleet.connections().find(value => value.url === b)!.token, backend.token);
});

test("an explicit HTTPS address repair propagates to another viewer while the serving loopback stays local", async t => {
  const net = network(), desktop = await viewer(t, net, "desktop", [local, b], local);
  await desktop.sync.refresh();
  const phone = await viewer(t, net, "phone", [b]); await phone.sync.refresh();
  phone.fleet.choose(b);
  const https = "https://nuc.synthetic.test";
  net.backends.set(https, net.backends.get(b)!);
  const repair = await desktop.add(https, key("nuc"), b);
  assert.equal(await desktop.sync.connected(repair), true);
  await phone.sync.refresh(); await turn(); await phone.sync.refresh();
  assert.deepEqual(new Set(phone.fleet.connections().map(connection => connection.url)), new Set([a, https]));
  assert.equal(phone.fleet.activeUrl(), https);
  assert.equal(phone.fleet.connections().find(connection => connection.url === https)!.token, key("nuc"));
  assert(desktop.fleet.connections().some(connection => connection.url === local));
  assert(!desktop.fleet.connections().some(connection => connection.url === a || connection.url === b));
  const endpoint = phone.endpoints.get(https)!;
  await phone.sync.refresh();
  assert.equal(phone.endpoints.get(https), endpoint, "unchanged canonical URLs must not replace transports");
});

test("unpersisted offline removal reports failure and retries the pending tombstone when storage recovers", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b]); await f.sync.refresh();
  f.endpoints.get(a)!.offline(); f.endpoints.get(b)!.offline();
  let writable = false;
  const saveCache = f.settings.saveComputerCache.bind(f.settings), saveConnections = f.settings.replaceConnections.bind(f.settings);
  t.mock.method(f.settings, "saveComputerCache", async (book: ComputerBook, aliases: { id: string; url: string }[]) => writable ? saveCache(book, aliases) : false);
  t.mock.method(f.settings, "replaceConnections", async (connections: Connection[], active?: string) => writable ? saveConnections(connections, active) : false);
  assert.equal(await f.sync.remove(b), false);
  assert(f.errors.some(error => /could not be updated/.test(error)));
  assert(f.fleet.connections().some(connection => connection.url === b), "an unsaved shared change remains pending");
  writable = true; await f.sync.refresh();
  assert.equal(f.settings.computerBook().entries.find(entry => entry.id === "nuc")!.deleted, true);
  assert(!f.fleet.connections().some(connection => connection.url === b));
});

test("two rapid UI removals finish in order and cannot resurrect the first computer", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b, c]); await f.sync.refresh();
  const actions = new ConnectionActions(), entered: string[] = [], hold = deferred<unknown>(); let blocked = true;
  const stale = structuredClone(net.backends.get(a)!.book);
  net.setIntercept((_name, connection, path, body) => blocked && connection.url === a && path === "/api/computers" && !body ? hold.promise : undefined);
  const remove = (url: string) => actions.run(async () => {
    entered.push(url); const saved = await f.sync.remove(url);
    if (!saved) { await f.settings.remove(url); f.fleet.remove(url); }
    return saved;
  });
  const first = remove(b), second = remove(c); await turn();
  assert.deepEqual(entered, [b]);
  blocked = false; hold.resolve({ ...stale, owner: { id: "laptop", name: "laptop", url: a } });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  await f.sync.refresh();
  assert.deepEqual(f.fleet.connections().map(value => value.url), [a]);
  assert.equal(f.settings.computerBook().entries.find(entry => entry.id === "nuc")!.deleted, true);
  assert.equal(f.settings.computerBook().entries.find(entry => entry.id === "third")!.deleted, true);
});

test("a queued reconnect follows removal and cannot be deleted by an older UI fallback", async t => {
  const net = network(), f = await viewer(t, net, "desktop", [a, b]); await f.sync.refresh();
  const actions = new ConnectionActions(), entered: string[] = [], hold = deferred<unknown>(); let blocked = true;
  const stale = structuredClone(net.backends.get(a)!.book);
  net.setIntercept((_name, connection, path, body) => blocked && connection.url === a && path === "/api/computers" && !body ? hold.promise : undefined);
  const remove = actions.run(async () => {
    entered.push("remove"); const saved = await f.sync.remove(b);
    if (!saved) { await f.settings.remove(b); f.fleet.remove(b); }
    return saved;
  });
  const reconnect = actions.run(async () => {
    entered.push("reconnect"); net.backends.get(b)!.token = key("repaired-nuc");
    const connection = await f.add(b); return f.sync.connected(connection);
  });
  await turn(); assert.deepEqual(entered, ["remove"]);
  blocked = false; hold.resolve({ ...stale, owner: { id: "laptop", name: "laptop", url: a } });
  assert.deepEqual(await Promise.all([remove, reconnect]), [true, true]);
  await f.sync.refresh();
  assert.equal(f.fleet.connections().find(value => value.url === b)!.token, key("repaired-nuc"));
  assert.equal(f.settings.computerBook().entries.find(entry => entry.id === "nuc")!.deleted, undefined);
});

test("a native tombstone arriving during a pending GET cannot be overwritten or resurrect its removed transport", async t => {
  const net = network(), f = await viewer(t, net, "phone", [a, b]); await f.sync.refresh();
  const hold = deferred<unknown>(), stale = structuredClone(net.backends.get(a)!.book); let blocked = true;
  net.setIntercept((_name, connection, path, body) => blocked && connection.url === a && path === "/api/computers" && !body ? hold.promise : undefined);
  const pending = f.sync.refresh(); await turn();
  const native = { version: 1, updatedAt: Date.now() + 10_000, connection: { url: a, token: key("laptop") },
    connections: [{ url: a, token: key("laptop") }], computerAliases: [{ id: "laptop", url: a }, { id: "nuc", url: b }],
    computerBook: { version: 1, entries: [{ id: "nuc", deleted: true, stamp: { counter: 99, writer: "native-phone" } }] } };
  await f.settings.attachBridge({ getLocalStorage: async () => JSON.stringify(native), setLocalStorage: async () => true });
  await restoreViewerConnections(f.fleet, f.settings.all(), f.settings.current()?.url);
  blocked = false; hold.resolve({ ...stale, owner: { id: "laptop", name: "laptop", url: a } });
  await pending; await f.sync.refresh();
  assert(!f.fleet.connections().some(value => value.url === b));
  const deletion = f.settings.computerBook().entries.find(entry => entry.id === "nuc")!;
  assert.equal(deletion.deleted, true); assert.equal(deletion.stamp.counter, 99);
  assert(!JSON.stringify(f.settings.computerBook()).includes(key("nuc")));
});
