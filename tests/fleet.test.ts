import test from "node:test";
import assert from "node:assert/strict";
import { FleetClient, scopedKey } from "../apps/evenhub/src/bridge/fleet.js";
import { initialState, type RuntimeState } from "../packages/cockpit-state/types.js";
import { statusBar } from "../packages/cockpit-state/selectors.js";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { setTimeout as delay } from "node:timers/promises";

const a = "http://100.64.0.1:4317", b = "http://100.64.0.2:4317", key = "a".repeat(32);
function fixture() {
  const calls: { url: string; token: string; path: string; data?: any }[] = [];
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
      request: async (path, data) => {
        calls.push({ url: connection.url, token: connection.token, path, data });
        if (path === "/api/host") return { id: connection.url, name: connection.url === a ? "liam" : "nuc", nameSource: "tailscale" };
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
