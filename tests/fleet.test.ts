import test from "node:test";
import assert from "node:assert/strict";
import { FleetClient, scopedKey } from "../apps/evenhub/src/bridge/fleet.js";
import { restoreViewerConnections } from "../apps/evenhub/src/bridge/restore.js";
import { initialState, type RuntimeState } from "../packages/cockpit-state/types.js";
import { statusBar } from "../packages/cockpit-state/selectors.js";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { setTimeout as delay } from "node:timers/promises";

const a = "http://100.64.0.1:4317", b = "http://100.64.0.2:4317", key = "a".repeat(32);
function fixture(identity?: (connection: { url: string; token: string }) => Promise<unknown>,
  respond?: (connection: { url: string; token: string }, path: string, data?: any) => Promise<unknown> | undefined) {
  const calls: { url: string; token: string; path: string; data?: any; timeout?: number }[] = [];
  const endpoints = new Map<string, { state: RuntimeState; online: (value: boolean, error?: string) => void; update: (value: RuntimeState) => void; viewed?: string; closed: boolean }>();
  const states: RuntimeState[] = [];
  const connectionMessages: (string | undefined)[] = [];
  const fleet = new FleetClient(state => states.push(state), (_online, message) => connectionMessages.push(message), () => {}, () => {}, (connection, update, online) => {
    const state = initialState("/project"); state.connected = true; state.main.status = "running";
    state.session = { key, id: "same-native-id", name: "Same title", cwd: "/project", model: "test-model", tunnel: "pi" };
    state.monitoring = { running: 1, watched: 1, since: 1000, sessions: [{ key, name: "Same title", cwd: "/project", status: "running", monitored: true, current: true, updatedAt: connection.url === a ? 1000 : 2000 }] };
    const endpoint = { state, update, online, viewed: undefined as string | undefined, closed: false }; endpoints.set(connection.url, endpoint);
    return {
      verify: async () => endpoint.state,
      connect: () => { online(true); update(endpoint.state); },
      disconnect: () => { endpoint.closed = true; endpoint.viewed = undefined; },
      reconnect: () => { endpoint.closed = false; online(true); update(endpoint.state); },
      setViewedSession: value => { endpoint.viewed = value; },
      request: async (path, data, timeout) => {
        calls.push({ url: connection.url, token: connection.token, path, data, ...(timeout === undefined ? {} : { timeout }) });
        const response = respond?.(connection, path, data);
        if (response) return response;
        if (path === "/api/host") return identity ? identity(connection) : { id: connection.url, name: connection.url === a ? "liam" : "nuc", nameSource: "tailscale" };
        if (path === "/api/state") return endpoint.state;
        if (path === "/api/sessions") return { sessions: [{ ...endpoint.state.session, runtimeStatus: endpoint.state.main.status, live: true, monitored: true,
          updatedAt: endpoint.state.monitoring!.sessions[0].updatedAt }], skipped: 0 };
        if (path.endsWith("/monitor")) {
          endpoint.state.monitoring!.sessions[0].monitored = (data as any).monitored;
          return endpoint.state;
        }
        if (path.endsWith("/history")) return { session: endpoint.state.session, messages: [] };
        if (path === "/api/session/resume" || path === "/api/session/new") return endpoint.state;
        return { accepted: true };
      },
    };
  });
  const add = async () => { await fleet.add({ url: a, token: "token-for-laptop" }); await fleet.add({ url: b, token: "token-for-nuc" }, false, false); };
  return { fleet, calls, endpoints, states, connectionMessages, add };
}

const flushMetadata = () => new Promise<void>(done => setImmediate(done));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("a key rejected by identity lookup after state verification cannot save or replace a computer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const requests: { origin: string; path: string; token: string | null }[] = [], streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let originalSignal!: AbortSignal;
  const state = initialState("/fixture");
  t.mock.method(globalThis, "fetch", async (input: any, options: any) => {
    const url = new URL(String(input)), token = new Headers(options.headers).get("Authorization");
    requests.push({ origin: url.origin, path: url.pathname, token });
    if (url.pathname === "/api/state") return Response.json(state);
    if (url.pathname === "/api/host") return token === "Bearer invalid-identity-key" ? new Response("Unauthorized", { status: 401 })
      : Response.json({ id: url.origin, name: "Original computer", nameSource: "hostname" });
    assert.equal(url.pathname, "/api/events"); originalSignal = options.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }));
  });
  const fleet = new FleetClient(() => {}, () => {}, () => {});
  t.after(() => { fleet.disconnect(); for (const stream of streams) try { stream.close(); } catch {} });
  await assert.rejects(fleet.add({ url: b, token: "invalid-identity-key" }), /Connection key rejected/);
  assert.deepEqual(fleet.connections(), []);
  assert.deepEqual(requests.map(request => request.path), ["/api/state", "/api/host"]);
  const original = { url: a, token: "original-key" };
  await fleet.add(original); await flushMetadata();
  assert.equal(fleet.hosts()[0].online, true); assert.equal(originalSignal.aborted, false);
  const failedAt = requests.length;
  await assert.rejects(fleet.add({ url: a, token: "invalid-identity-key" }), /Connection key rejected/);
  assert.deepEqual(fleet.connections(), [original]); assert.equal(originalSignal.aborted, false);
  assert.equal(fleet.hosts()[0].connectionState, "online");
  assert.deepEqual(requests.slice(failedAt).map(request => request.path), ["/api/state", "/api/host"]);
  const rejectedRequests = requests.filter(request => request.token === "Bearer invalid-identity-key").length;
  t.mock.timers.tick(30_000); await flushMetadata();
  assert.equal(requests.filter(request => request.token === "Bearer invalid-identity-key").length, rejectedRequests, "rejected candidates never start a stream or automatic retries");
});

test("an idle restored computer retries a failed name lookup without new SSE state events", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let reads = 0;
  const f = fixture(async () => {
    if (++reads === 1) throw new Error("Temporary network failure");
    return { id: "laptop", name: "liam", nameSource: "tailscale" };
  });
  t.after(() => f.fleet.disconnect());
  await f.fleet.add({ url: a, token: "local-key" }, true); await flushMetadata();
  assert.equal(f.fleet.hosts()[0].name, "100.64.0.1");
  assert.equal(reads, 1);
  t.mock.timers.tick(1999); await flushMetadata(); assert.equal(reads, 1);
  t.mock.timers.tick(1); await flushMetadata();
  assert.equal(reads, 2); assert.equal(f.fleet.snapshot().source?.name, "liam");
  assert.equal(f.fleet.snapshot().monitoring?.sessions[0].source?.name, "liam");
  const emissions = f.states.length;
  t.mock.timers.tick(60_000); await flushMetadata();
  assert.equal(reads, 3); assert.equal(f.states.length, emissions, "unchanged name polls cause no extra display updates");
  assert(f.calls.every(call => call.path === "/api/host" && call.data === undefined));
});

test("name lookup failures keep verified names, back off, and stop when disconnected", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let reads = 0;
  const f = fixture(async () => {
    if (++reads > 1) throw new Error("Temporary network failure");
    return { id: "laptop", name: "liam", nameSource: "tailscale" };
  });
  t.after(() => f.fleet.disconnect());
  await f.fleet.add({ url: a, token: "local-key" }, true); await flushMetadata();
  t.mock.timers.tick(60_000); await flushMetadata(); assert.equal(reads, 2);
  assert.equal(f.fleet.hosts()[0].name, "liam");
  t.mock.timers.tick(2000); await flushMetadata(); assert.equal(reads, 3);
  t.mock.timers.tick(3999); await flushMetadata(); assert.equal(reads, 3);
  t.mock.timers.tick(1); await flushMetadata(); assert.equal(reads, 4);
  f.endpoints.get(a)!.online(false);
  t.mock.timers.tick(2 * 60_000); await flushMetadata(); assert.equal(reads, 4);
  assert.equal(f.fleet.snapshot().monitoring?.watched, 1, "metadata retries never change Watch");
  f.endpoints.get(a)!.online(true); await flushMetadata(); assert.equal(reads, 5);
  f.fleet.disconnect(); t.mock.timers.tick(2 * 60_000); await flushMetadata(); assert.equal(reads, 5);
});

test("late and malformed identities cannot overwrite a replaced or removed connection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let finish!: (value: unknown) => void, reads = 0;
  const f = fixture(async connection => {
    reads++;
    if (connection.token === "old-key") return new Promise(done => { finish = done; });
    return { id: "replacement", name: "current-name", nameSource: "tailscale" };
  });
  t.after(() => f.fleet.disconnect());
  await f.fleet.add({ url: a, token: "old-key" }, true);
  await f.fleet.add({ url: a, token: "new-key" }, true); await flushMetadata();
  finish({ id: "stale", name: "stale-name", nameSource: "tailscale" }); await flushMetadata();
  assert.equal(f.fleet.hosts()[0].name, "current-name");
  f.fleet.remove(a); t.mock.timers.tick(2 * 60_000); await flushMetadata(); assert.equal(reads, 2);
  let invalidReads = 0;
  const invalid = fixture(async () => ++invalidReads === 1 ? { name: "broken" } : { id: "fixed", name: "fixed-name", nameSource: "tailscale" });
  t.after(() => invalid.fleet.disconnect());
  await invalid.fleet.add({ url: a, token: "key" }, true); await flushMetadata();
  t.mock.timers.tick(2000); await flushMetadata(); assert.equal(invalid.fleet.hosts()[0].name, "fixed-name");
});

test("desktop restores all explicitly saved computers and prefers the saved active source", async t => {
  const f = fixture(), saved = [{ url: a, token: "local-key" }, { url: b, token: "remote-key" }];
  t.after(() => f.fleet.disconnect());
  const before = structuredClone(saved);
  await restoreViewerConnections(f.fleet, saved, b, a);
  assert.deepEqual(f.fleet.connections(), saved);
  assert.equal(f.fleet.activeUrl(), b);
  assert.equal(f.endpoints.size, 2);
  const rows = (await f.fleet.request("/api/sessions")).sessions;
  assert.deepEqual(rows.map((row: any) => row.key), [scopedKey(b, key), scopedKey(a, key)]);
  assert(f.calls.some(call => call.url === a) && f.calls.some(call => call.url === b));
  assert(f.calls.every(call => ["/api/host", "/api/sessions"].includes(call.path) && call.data === undefined), "restoring and browsing never Watch, open, create or relay sessions");
  assert(f.calls.every(call => call.token === saved.find(item => item.url === call.url)?.token), "each credential stays on its own computer");
  assert.equal(f.fleet.snapshot().monitoring?.watched, 2);
  assert.deepEqual(saved, before, "restoration preserves saved credentials and preferences");
});

test("desktop falls back to its saved serving computer only when the saved active source is missing", async t => {
  const saved = [{ url: b, token: "remote-key" }, { url: a, token: "local-key" }];
  for (const activeUrl of [undefined, "http://100.64.0.3:4317"]) {
    const f = fixture(); t.after(() => f.fleet.disconnect());
    await restoreViewerConnections(f.fleet, saved, activeUrl, a);
    assert.deepEqual(f.fleet.connections(), saved);
    assert.equal(f.fleet.activeUrl(), a);
  }
  const remoteOnly = fixture(); t.after(() => remoteOnly.fleet.disconnect());
  await restoreViewerConnections(remoteOnly.fleet, [saved[0]], b, a);
  assert.equal(remoteOnly.fleet.activeUrl(), b);
  assert.equal(remoteOnly.endpoints.has(a), false, "a serving origin without saved credentials is never discovered or added");
  const empty = fixture(); t.after(() => empty.fleet.disconnect());
  await restoreViewerConnections(empty.fleet, [], b, a);
  assert.deepEqual(empty.fleet.connections(), []);
  assert.equal(empty.endpoints.size, 0);
});

test("desktop restoration retains failed remotes, replaces changed credentials and removes unsaved connections independently", async t => {
  const f = fixture(); t.after(() => f.fleet.disconnect());
  await f.add();
  const local = f.endpoints.get(a)!, remote = f.endpoints.get(b)!;
  remote.online(false, "Connection key rejected. Open Connection and update this computer’s key.");
  f.calls.length = 0;
  await restoreViewerConnections(f.fleet, f.fleet.connections(), b, a);
  assert.equal(f.endpoints.get(a), local);
  assert.equal(f.endpoints.get(b), remote);
  assert.equal(remote.closed, false);
  assert.equal(f.fleet.activeUrl(), b, "the saved active source remains selected even when offline");
  assert.equal(f.fleet.hosts().find(host => host.url === b)?.online, false);
  assert.equal(f.fleet.snapshot().monitoring?.watched, 2);
  const rows = (await f.fleet.request("/api/sessions")).sessions;
  assert.equal(rows.find((row: any) => row.source.url === b).runtimeStatus, "offline");
  assert(f.calls.every(call => call.url === a && call.token === "token-for-laptop" && call.data === undefined));

  const saved = [{ url: a, token: "current-local-key" }, { url: b, token: "token-for-nuc" }];
  await restoreViewerConnections(f.fleet, saved, b, a);
  assert.equal(local.closed, true);
  assert.notEqual(f.endpoints.get(a), local);
  assert.equal(f.endpoints.get(b), remote, "a changed local credential never recreates a failed remote connection");
  local.online(false); local.state.session.name = "stale"; local.update(local.state);
  assert.equal(f.fleet.hosts().find(host => host.url === a)?.online, true);
  assert.deepEqual(f.fleet.connections(), saved);
  assert(f.calls.every(call => call.data === undefined));
  assert(f.calls.some(call => call.url === a && call.token === "current-local-key"));

  await restoreViewerConnections(f.fleet, [saved[1]], b, a);
  assert.equal(f.endpoints.get(a)?.closed, true);
  assert.equal(f.endpoints.get(a)?.state.monitoring?.sessions[0].monitored, true, "removing a viewer never unwatches its session");
  local.update(local.state);
  assert.deepEqual(f.fleet.connections(), [saved[1]]);
  assert.equal(remote.closed, false);
});

test("phone restores all saved computers and its selected session source", async t => {
  const f = fixture(), saved = [{ url: a, token: "local-key" }, { url: b, token: "remote-key" }];
  t.after(() => f.fleet.disconnect());
  await restoreViewerConnections(f.fleet, saved, b);
  assert.deepEqual(f.fleet.connections(), saved);
  assert.equal(f.fleet.activeUrl(), b);
  assert.equal(f.endpoints.size, 2);
  assert(f.calls.every(call => call.data === undefined), "viewing does not change notification routing or Watch");
});

test("fleet combines identical native session keys with distinct source names and globally recent ordering", async () => {
  const f = fixture(); await f.add();
  const result = await f.fleet.request("/api/sessions");
  assert.deepEqual(result.sessions.map((s: any) => [s.key, s.source.name]), [[scopedKey(b, key), "nuc"], [scopedKey(a, key), "liam"]]);
  assert.equal(f.fleet.snapshot().monitoring?.watched, 2);
  assert.equal(f.fleet.snapshot().monitoring?.running, 2);
  assert.equal(f.fleet.snapshot().source?.name, "liam");
  f.fleet.disconnect();
});

test("prompts, interrupt, Watch, history and choices use only the target computer and its credential", async () => {
  const f = fixture(); await f.add(); f.calls.length = 0;
  const scoped = scopedKey(b, key);
  await f.fleet.request("/api/prompt", { text: "hello", sessionKey: scoped, source: "g2" });
  await f.fleet.request(`/api/runtime/${encodeURIComponent(scoped)}/interrupt`, {});
  await f.fleet.request(`/api/runtime/${scoped}/monitor`, { monitored: false });
  const history = await f.fleet.request(`/api/sessions/${encodeURIComponent(scoped)}/history`);
  await f.fleet.request("/api/interaction/respond", { sessionKey: scoped, requestId: "choice", answers: { option: "yes" } });
  assert(f.calls.every(call => call.url === b && call.token === "token-for-nuc"));
  assert.equal(f.calls[0].data.sessionKey, key); assert.equal(f.calls[0].data.source, "g2");
  assert.equal(f.calls[1].path, `/api/runtime/${key}/interrupt`);
  assert.equal(history.session.key, scoped); assert.equal(history.session.source.name, "nuc");
  assert.equal(f.fleet.activeUrl(), a, "Background Watch/prompt operations never steal selection");
  assert.equal(f.fleet.snapshot().monitoring?.sessions.find(s => s.source?.name === "liam")?.monitored, true);
  f.fleet.disconnect();
});

test("one disconnected host keeps Watch/cache and cannot fabricate idle or route commands to the other host", async () => {
  const f = fixture(); await f.add(); await f.fleet.request("/api/sessions");
  f.endpoints.get(b)!.online(false); f.calls.length = 0;
  const rows = (await f.fleet.request("/api/sessions")).sessions;
  assert.equal(rows.find((s: any) => s.source.name === "nuc").monitored, true);
  assert.equal(rows.find((s: any) => s.source.name === "nuc").runtimeStatus, "offline");
  assert.equal(f.fleet.snapshot().monitoring?.watched, 2);
  assert.equal(statusBar(f.fleet.snapshot(), true).status, "PARTIAL");
  assert.equal(statusBar(f.fleet.snapshot(), true).agents, "1+? AGENTS");
  await assert.rejects(f.fleet.request("/api/prompt", { sessionKey: scopedKey(b, key), text: "do not misroute" }), /nuc is offline/);
  assert(f.calls.every(call => call.data === undefined));
  await f.fleet.request("/api/prompt", { sessionKey: scopedKey(a, key), text: "still works" });
  assert.equal(f.calls.at(-1)?.url, a);
  f.endpoints.get(b)!.online(true);
  assert.equal(f.fleet.snapshot().monitoring?.watched, 2);
  f.fleet.disconnect();
});

test("G2 viewing suppression transfers between hosts without leaking a native key to the wrong bridge", async () => {
  const f = fixture(); await f.add();
  f.fleet.setViewedSession(scopedKey(a, key));
  assert.equal(f.endpoints.get(a)!.viewed, key); assert.equal(f.endpoints.get(b)!.viewed, undefined);
  await f.fleet.request("/api/session/resume", { key: scopedKey(b, key), watchedOnly: true });
  assert.equal(f.endpoints.get(a)!.viewed, undefined);
  f.fleet.setViewedSession(scopedKey(b, key));
  assert.equal(f.endpoints.get(b)!.viewed, key);
  f.endpoints.get(b)!.online(false); assert.equal(f.endpoints.get(b)!.viewed, undefined);
  f.fleet.disconnect();
});

test("fleet names the host with a rejected key instead of hiding authentication behind offline", async () => {
  const f = fixture(); await f.add();
  f.endpoints.get(b)!.online(false, "Connection key rejected. Open Connection and update this computer’s key.");
  assert.equal(f.connectionMessages.at(-1), undefined, "another computer's failure does not replace the selected online viewer with an error");
  assert.match(f.fleet.hosts().find(host => host.url === b)!.warning!, /Connection key rejected/);
  f.fleet.choose(b);
  assert.match(f.connectionMessages.at(-1)!, /^nuc: Connection key rejected/);
  assert.doesNotMatch(f.connectionMessages.at(-1)!, /nuc offline/);
  assert.match(f.fleet.hosts().find(host => host.url === b)!.warning!, /Connection key rejected/);
  assert.equal(f.fleet.snapshot().monitoring!.watched, 2);
  assert.equal(f.endpoints.get(a)!.closed, false);
  f.endpoints.get(b)!.online(true); assert.equal(f.connectionMessages.at(-1), undefined);
  f.fleet.disconnect();
});

test("removed and superseded connections cannot resurrect state, receive commands or affect another host", async () => {
  const f = fixture(); await f.add();
  const old = f.endpoints.get(b)!;
  await f.fleet.add({ url: b, token: "new-nuc-token" }, false, false);
  old.online(false); old.state.session.name = "stale"; old.update(old.state);
  assert.equal(f.fleet.hosts().find(host => host.url === b)?.online, true);
  f.fleet.remove(b);
  old.update(old.state);
  assert.equal(f.fleet.hosts().length, 1);
  await assert.rejects(f.fleet.request(`/api/runtime/${scopedKey(b, key)}/interrupt`, {}), /removed or changed/);
  assert.equal(f.endpoints.get(a)!.closed, false);
  await assert.rejects(f.fleet.add({ url: b, token: "late-token" }, false, true, () => false), /replaced/);
  assert.equal(f.fleet.hosts().length, 1);
  f.fleet.disconnect();
});

test("new terminal source is explicit and is stripped from the native backend request", async () => {
  const f = fixture(); await f.add();
  await f.fleet.request("/api/session/new", { sourceUrl: b, tunnel: "codex", cwd: "/work" });
  const sent = f.calls.find(call => call.path === "/api/session/new")!;
  assert.equal(sent.url, b); assert.deepEqual(sent.data, { tunnel: "codex", cwd: "/work" });
  assert.equal(f.fleet.activeUrl(), b);
  f.fleet.disconnect();
});

test("late fallback state from a replaced or removed connection cannot select it or overwrite another host", async t => {
  for (const change of ["replace", "remove"] as const) {
    const read = deferred<void>(), state = deferred<RuntimeState>();
    const f = fixture(undefined, (connection, path) => {
      if (connection.url !== b || connection.token !== "token-for-nuc") return;
      if (path === "/api/session/resume") return Promise.resolve({ accepted: true });
      if (path === "/api/state") { read.resolve(); return state.promise; }
    });
    t.after(() => f.fleet.disconnect()); await f.add();
    const old = f.endpoints.get(b)!;
    const opening = f.fleet.request("/api/session/resume", { key: scopedKey(b, key) });
    await read.promise;
    if (change === "replace") await f.fleet.add({ url: b, token: "replacement-nuc-token" }, true, false);
    else f.fleet.remove(b);
    f.fleet.choose(a);
    const rejected = assert.rejects(opening, /removed or reconfigured/);
    state.resolve({ ...old.state, session: { ...old.state.session, name: "Stale response" } });
    await rejected;
    assert.equal(f.fleet.activeUrl(), a);
    assert.equal(f.fleet.snapshot().source?.url, a);
    assert.equal(f.fleet.snapshot().session.name, "Same title");
    assert.equal(old.closed, true);
    if (change === "replace") {
      assert.notEqual(f.endpoints.get(b), old);
      assert.equal(f.endpoints.get(b)?.state.session.name, "Same title");
      assert.equal(f.fleet.connections().find(connection => connection.url === b)?.token, "replacement-nuc-token");
    } else assert.equal(f.fleet.hosts().some(host => host.url === b), false);
  }
});

test("delayed opening responses keep a newer deliberate selection, including reselecting the same computer", async t => {
  for (const fallback of [false, true]) for (const initialUrl of [a, b]) {
    const read = deferred<void>(), response = deferred<RuntimeState>();
    const f = fixture(undefined, (connection, path) => {
      if (connection.url !== b) return;
      if (path === "/api/session/resume") {
        if (fallback) return Promise.resolve({ accepted: true });
        read.resolve(); return response.promise;
      }
      if (fallback && path === "/api/state") { read.resolve(); return response.promise; }
    });
    t.after(() => f.fleet.disconnect()); await f.add();
    f.fleet.choose(initialUrl);
    const opening = f.fleet.request("/api/session/resume", { key: scopedKey(b, key) });
    await read.promise;
    f.fleet.choose(a);
    f.fleet.setViewedSession(scopedKey(a, key));
    const remote = f.endpoints.get(b)!.state;
    response.resolve({ ...remote, session: { ...remote.session, name: "Late response" } });
    const result = await opening;
    assert.equal(f.fleet.activeUrl(), a);
    assert.equal(result.source.url, a, "callers receive the current viewer snapshot");
    assert.equal(result.session.key, scopedKey(a, key));
    assert.equal(f.states.at(-1)?.source?.url, a);
    assert.equal(f.endpoints.get(a)?.viewed, key);
    assert.equal(f.endpoints.get(b)?.viewed, undefined);
    f.fleet.choose(b);
    assert.equal(f.fleet.snapshot().session.name, "Same title", "an obsolete opening response cannot replace cached host state");
  }
});

test("a current terminal-opening request with fallback state still selects its target computer", async t => {
  const f = fixture(); t.after(() => f.fleet.disconnect()); await f.add();
  const result = await f.fleet.request(`/api/runtime/${scopedKey(b, key)}/terminal`, {});
  assert.equal(f.fleet.activeUrl(), b);
  assert.equal(result.source.url, b);
  assert.equal(result.session.key, scopedKey(b, key));
  assert.equal(result.monitoring.watched, 2);
});

test("the newest overlapping opening request wins in either completion order across hosts or sessions on one host", async t => {
  const c = "http://100.64.0.3:4317", newerKey = "b".repeat(32);
  for (const sameHost of [false, true]) for (const olderFirst of [false, true]) {
    const older = deferred<RuntimeState>(), newer = deferred<RuntimeState>();
    const f = fixture(undefined, (connection, path, data) => {
      if (path !== "/api/session/resume") return;
      return connection.url === b && data.key === key ? older.promise : newer.promise;
    });
    t.after(() => f.fleet.disconnect()); await f.add();
    if (!sameHost) await f.fleet.add({ url: c, token: "token-for-third-computer" }, true, false);
    const newerUrl = sameHost ? b : c;
    const olderState = f.endpoints.get(b)!.state, newerState = f.endpoints.get(newerUrl)!.state;
    const first = f.fleet.request("/api/session/resume", { key: scopedKey(b, key) });
    const second = f.fleet.request("/api/session/resume", { key: scopedKey(newerUrl, newerKey) });
    const finishOlder = () => older.resolve({ ...olderState, session: { ...olderState.session, key, name: "Older session" } });
    const finishNewer = () => newer.resolve({ ...newerState, session: { ...newerState.session, key: newerKey, name: "Newer session" } });
    if (olderFirst) {
      finishOlder(); const firstResult = await first;
      assert.equal(f.fleet.activeUrl(), a, "the earlier response cannot select while a newer opening is pending");
      assert.equal(firstResult.source.url, a);
      finishNewer(); await second;
    } else {
      finishNewer(); await second;
      finishOlder(); const firstResult = await first;
      assert.equal(firstResult.source.url, newerUrl);
      assert.equal(firstResult.session.key, scopedKey(newerUrl, newerKey));
    }
    assert.equal(f.fleet.activeUrl(), newerUrl);
    assert.equal(f.fleet.snapshot().session.key, scopedKey(newerUrl, newerKey));
    assert.equal(f.fleet.snapshot().session.name, "Newer session");
    f.fleet.choose(b);
    assert.equal(f.fleet.snapshot().session.name, sameHost ? "Newer session" : "Same title", "stale responses never overwrite host caches");
  }
});

test("saved computers have independent retry budgets and targeted reconnect retains Watch and the selected online viewer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>(), attempts = new Map<string, number>();
  const requests: { url: string; path: string; token: string | null }[] = [], messages: (string | undefined)[] = [];
  let recoverRemote = false;
  const state = initialState("/fixture"); state.connected = true;
  state.session = { key, id: "saved-session", cwd: "/fixture", tunnel: "pi" };
  state.monitoring = { watched: 1, running: 0, since: 1,
    sessions: [{ key, cwd: "/fixture", name: "Watched", status: "idle", monitored: true, current: true }] };
  t.mock.method(globalThis, "fetch", async (input: any, options: any) => {
    const url = new URL(String(input));
    requests.push({ url: url.origin, path: url.pathname, token: new Headers(options.headers).get("authorization") });
    if (url.pathname === "/api/events") {
      const count = (attempts.get(url.origin) || 0) + 1; attempts.set(url.origin, count);
      if (url.origin === b && count > 1 && !recoverRemote) throw new TypeError("Remote offline");
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        streams.set(url.origin, controller);
        controller.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify(state)}\n\n`));
      } }));
    }
    if (url.pathname === "/api/host") return Response.json({ id: url.origin, name: url.origin === a ? "liam" : "nuc", nameSource: "tailscale" });
    if (url.pathname === "/api/g2/view") return Response.json({ accepted: true });
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  });
  const fleet = new FleetClient(() => {}, (_online, message) => messages.push(message), () => {});
  t.after(() => { fleet.disconnect(); for (const stream of streams.values()) try { stream.close(); } catch {} });
  const saved = [{ url: a, token: "synthetic-local-key" }, { url: b, token: "synthetic-remote-key" }];
  await restoreViewerConnections(fleet, saved, a); await flushMetadata();
  assert.deepEqual([...attempts.values()], [1, 1]);
  assert(requests.every(request => request.path !== "/api/state"), "saved startup uses one stream attempt and no duplicate verification probe");
  assert.equal(fleet.snapshot().monitoring?.watched, 2);
  streams.get(b)!.error(new TypeError("Remote offline")); await flushMetadata();
  for (let retry = 1; retry <= 5; retry++) {
    streams.get(a)!.enqueue(new TextEncoder().encode(": heartbeat\n\n")); await flushMetadata();
    t.mock.timers.tick(30_000); await flushMetadata();
    const remote = fleet.hosts().find(host => host.url === b)!;
    assert.equal(attempts.get(b), retry + 1);
    assert.equal(remote.retryAttempt, retry);
    assert.equal(remote.connectionState, retry === 5 ? "offline" : "retrying");
    assert.equal(fleet.snapshot().connected, true);
    assert.equal(fleet.snapshot().source?.url, a);
    assert.equal(fleet.snapshot().monitoring?.watched, 2);
    assert.equal(messages.at(-1), undefined, "offline rows cannot leave an unrelated error on the valid selected session");
  }
  fleet.resume(); fleet.connect();
  streams.get(a)!.enqueue(new TextEncoder().encode(": heartbeat\n\n")); await flushMetadata();
  t.mock.timers.tick(30_000); await flushMetadata();
  assert.equal(attempts.get(a), 1); assert.equal(attempts.get(b), 6);
  assert.equal(fleet.hosts().find(host => host.url === b)?.connectionState, "offline");
  recoverRemote = true; fleet.reconnectHost(b); await flushMetadata();
  assert.equal(attempts.get(a), 1, "targeted manual reconnect does not disrupt another computer's stream");
  assert.equal(attempts.get(b), 7);
  assert.equal(fleet.activeUrl(), a);
  assert.equal(fleet.hosts().find(host => host.url === b)?.connectionState, "online");
  assert.equal(fleet.hosts().find(host => host.url === b)?.retryAttempt, 0);
  assert.equal(fleet.snapshot().monitoring?.watched, 2);
  assert(requests.every(request => request.token === "Bearer " + saved.find(connection => connection.url === request.url)?.token));
});

test("two authenticated HTTP bridges stream independently, isolate credentials and scope real G2 leases", async t => {
  const servers: { url: string; token: string; name: string; prompts: string[]; journal: NotificationJournal; close: () => Promise<void> }[] = [];
  for (const name of ["liam", "nuc"]) {
    const store = new CockpitStore("/fixture"), journal = new NotificationJournal(store), prompts: string[] = [];
    store.dispatch({ type: "session.updated", session: { key, id: "same-id", name: "Same title", cwd: "/fixture" } });
    store.dispatch({ type: "runtime.connected" });
    store.publish({ ...store.state, monitoring: { running: 0, watched: 1, since: 1,
      sessions: [{ key, name: "Same title", cwd: "/fixture", status: "idle", monitored: true, current: true }] } }, { type: "monitoring.updated" });
    const controller = { store, listSessions: async () => ({ sessions: [{ ...store.state.session, runtimeStatus: "idle", monitored: true, updatedAt: 1 }], skipped: 0 }),
      prompt: async (text: string) => { prompts.push(text); }, getRuntime: () => ({ store, prompt: async (text: string) => { prompts.push(text); } }) };
    const token = `synthetic-${name}-control-0123456789abcdef`;
    const bridge = createBridgeServer(controller as any, journal, { host: controller as any, token, notificationToken: `synthetic-${name}-notify-0123456789abcdef`,
      hostInfo: async () => ({ id: name, name, nameSource: "tailscale" }) });
    await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
    servers.push({ url: `http://127.0.0.1:${(bridge.server.address() as any).port}`, token, name, prompts, journal, close: bridge.close });
  }
  const fleet = new FleetClient(() => {}, () => {}, () => {});
  t.after(async () => { fleet.disconnect(); for (const server of servers) { await server.close(); server.journal.close(); } });
  for (const server of servers) await fleet.add({ url: server.url, token: server.token }, false, false);
  for (let n = 0; n < 100 && fleet.hosts().some(host => !host.online); n++) await delay(10);
  assert(fleet.hosts().every(host => host.online));
  assert.equal((await fleet.request("/api/sessions")).sessions.length, 2);
  for (const server of servers) {
    assert.equal((await fetch(server.url + "/api/host")).status, 401);
    assert.equal((await fetch(server.url + "/api/host", { headers: { Authorization: `Bearer synthetic-${server.name}-notify-0123456789abcdef` } })).status, 403);
  }
  await fleet.request("/api/prompt", { text: "Only on NUC", sessionKey: scopedKey(servers[1].url, key) });
  assert.deepEqual(servers[0].prompts, []); assert.deepEqual(servers[1].prompts, ["Only on NUC"]);
  fleet.setViewedSession(scopedKey(servers[0].url, key));
  for (let n = 0; n < 100 && !servers[0].journal.g2.viewing(key); n++) await delay(10);
  assert.equal(servers[0].journal.g2.viewing(key), true); assert.equal(servers[1].journal.g2.viewing(key), false);
  fleet.choose(servers[1].url); fleet.setViewedSession(scopedKey(servers[1].url, key));
  for (let n = 0; n < 100 && (!servers[1].journal.g2.viewing(key) || servers[0].journal.g2.viewing(key)); n++) await delay(10);
  assert.equal(servers[1].journal.g2.viewing(key), true); assert.equal(servers[0].journal.g2.viewing(key), false);
  await servers[0].close();
  for (let n = 0; n < 100 && fleet.hosts()[0].online; n++) await delay(10);
  assert.equal(fleet.hosts()[0].online, false); assert.equal(fleet.hosts()[1].online, true);
  assert.equal(fleet.snapshot().monitoring?.watched, 2);
});

test("an explicit address edit replaces only the verified same computer while the default duplicate guard remains", async t => {
  const alias = "https://laptop.synthetic.test";
  const f = fixture(async connection => ({ id: connection.url === b ? "different-computer" : "same-computer", name: "fixture", nameSource: "hostname" }));
  t.after(() => f.fleet.disconnect());
  await f.fleet.add({ url: a, token: "old-key" }); await flushMetadata();
  const original = f.endpoints.get(a)!;
  await assert.rejects(f.fleet.add({ url: alias, token: "new-key" }), /already saved/);
  assert.equal(original.closed, false); assert.equal(f.fleet.activeUrl(), a);
  await assert.rejects(f.fleet.add({ url: b, token: "other-key" }, false, true, () => true, a), /different device/);
  assert.equal(original.closed, false);
  await f.fleet.add({ url: alias, token: "new-key" }, false, true, () => true, a);
  assert.equal(original.closed, true); assert.equal(f.fleet.activeUrl(), alias);
  assert.deepEqual(f.fleet.connections(), [{ url: alias, token: "new-key" }]);
});

test("failed or cancelled address verification leaves the original transport and selection running", async t => {
  const alias = "https://laptop.synthetic.test";
  let fail = false;
  const f = fixture(async connection => {
    if (connection.url === alias && fail) throw new Error("Bridge returned 500");
    return { id: "same-computer", name: "fixture", nameSource: "hostname" };
  });
  t.after(() => f.fleet.disconnect());
  await f.fleet.add({ url: a, token: "old-key" }); await flushMetadata();
  const original = f.endpoints.get(a)!;
  fail = true;
  await assert.rejects(f.fleet.add({ url: alias, token: "new-key" }, false, true, () => true, a), /does not identify/);
  assert.equal(original.closed, false); assert.equal(f.fleet.activeUrl(), a);
  fail = false;
  await assert.rejects(f.fleet.add({ url: alias, token: "new-key" }, false, true, () => false, a), /attempt was replaced/);
  assert.equal(original.closed, false); assert.equal(f.fleet.activeUrl(), a);
  assert.deepEqual(f.fleet.connections(), [{ url: a, token: "old-key" }]);
});

test("requestFrom forwards the requested metadata timeout without replacing the transport", async t => {
  const f = fixture(); t.after(() => f.fleet.disconnect()); await f.add();
  const original = f.endpoints.get(b)!;
  await f.fleet.requestFrom(b, "/api/host", undefined, 5000);
  assert.equal(f.calls.at(-1)!.timeout, 5000); assert.equal(f.endpoints.get(b), original); assert.equal(original.closed, false);
});
