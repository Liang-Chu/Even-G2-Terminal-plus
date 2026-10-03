import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { InteractionBroker } from "../packages/connectors/interactions.js";
import { codexInteraction } from "../packages/connectors/codex-interactions.js";
import { codexTerminalLink } from "../packages/connectors/codex-terminal-link.js";
import { piCommand } from "../packages/connectors/pi-commands.js";
import { codexInput, slashCommand } from "../packages/connectors/slash-commands.js";
import { glassesInteraction, type Interaction } from "../packages/cockpit-state/interactions.js";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { initialState } from "../packages/cockpit-state/types.js";
import { readLocalJson, writeLocalJson } from "../packages/pi-runtime/native-protocol.js";
import { stdioRpc } from "../packages/connectors/rpc.js";
import monitorPi from "../apps/windows/src/pi-extension.js";
import { NativeHost } from "../packages/pi-runtime/native-host.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { sessionKey } from "../packages/pi-runtime/sessions.js";

const request = { kind: "question" as const, title: "Question", questions: [{ id: "q", text: "Which option?", options: [
  { id: "no", label: "No" }, { id: "yes", label: "Yes" },
] }] };
function brokerFixture() {
  let requests: Interaction[] = [];
  const broker = new InteractionBroker(value => { requests = value; });
  return { broker, get requests() { return requests; } };
}
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error("Fixture timeout"); await delay(20); } }
async function temp(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pilot-controls-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return root;
}

test("choices reject invalid/stale/duplicate answers and never replay an uncertain response", async () => {
  const f = brokerFixture(); let sent = 0;
  const remove = f.broker.add("request", request, async () => { sent++; });
  const id = f.requests[0].id;
  await assert.rejects(f.broker.respond({ requestId: id, answers: { q: "not-offered" } }), /current options/);
  await assert.rejects(f.broker.respond({ requestId: id, answers: {}, cancel: true }), /explicit option/);
  await f.broker.respond({ requestId: id, answers: { q: "yes" } });
  await assert.rejects(f.broker.respond({ requestId: id, answers: { q: "yes" } }), /expired/);
  assert.equal(sent, 1); remove(); assert.equal(f.requests.length, 0);
  f.broker.add("uncertain", request, async () => { sent++; throw new Error("Disconnected"); });
  const uncertain = f.requests[0].id;
  await assert.rejects(f.broker.respond({ requestId: uncertain, answers: { q: "yes" } }), /Disconnected/);
  await assert.rejects(f.broker.respond({ requestId: uncertain, answers: { q: "yes" } }), /expired/);
  assert.equal(sent, 2);
  f.broker.add("expired", { ...request, expiresAt: Date.now() - 1 }, async () => { sent++; });
  await assert.rejects(f.broker.respond({ requestId: f.requests[0].id, answers: { q: "yes" } }), /expired/);
  f.broker.add("session", request, async () => { sent++; }); const old = f.requests[0].id; f.broker.clear();
  await assert.rejects(f.broker.respond({ requestId: old, answers: { q: "yes" } }), /expired/);
  assert.equal(sent, 2);
});

test("Codex choices preserve question IDs, labels, free text, scope and explicit approval decisions", async () => {
  const f = brokerFixture(); let result: any;
  const msg = { id: 7, method: "item/tool/requestUserInput", params: { threadId: "thread", questions: [
    { id: "theme", question: "Theme?", options: [{ label: "Dark", description: "Dim" }] },
    { id: "name", question: "Name?", isOther: true, options: null },
  ] } };
  assert.equal(codexInteraction(msg, "foreign", f.broker, () => {}), undefined);
  codexInteraction(msg, "thread", f.broker, value => { result = value; });
  await f.broker.respond({ requestId: f.requests[0].id, answers: { theme: "choice:0", name: "Project A" } });
  assert.deepEqual(result, { answers: { theme: { answers: ["Dark"] }, name: { answers: ["Project A"] } } });
  codexInteraction({ id: 8, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread", command: "echo approved", availableDecisions: ["accept", "decline", "acceptForSession"],
  } }, "thread", f.broker, value => { result = value; });
  assert.deepEqual(f.requests[0].questions[0].options.map(o => o.id), ["decline", "accept"]);
  assert.match(f.requests[0].detail!, /echo approved/);
  await assert.rejects(f.broker.respond({ requestId: f.requests[0].id, answers: { decision: "acceptForSession" } }));
  await f.broker.respond({ requestId: f.requests[0].id, answers: { decision: "accept" } });
  assert.deepEqual(result, { decision: "accept" });
});

test("native Codex and remote choices race on the same request without duplicate replies", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const f = brokerFixture(), received: any[] = [];
  server.on("connection", socket => socket.on("message", raw => received.push(JSON.parse(raw.toString()))));
  const link = await codexTerminalLink("ws://127.0.0.1:" + (server.address() as any).port, "fixture", () => {}, () => {},
    (message, respond) => codexInteraction(message, "thread", f.broker, respond));
  const client = new WebSocket(link.url, { headers: { Authorization: "Bearer fixture" } });
  t.after(() => { client.terminate(); link.close(); for (const socket of server.clients) socket.terminate(); server.close(); });
  await once(client, "open"); await until(() => server.clients.size === 1);
  const upstream = [...server.clients][0];
  const show = (id: string) => upstream.send(JSON.stringify({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread", command: "echo test" } }));
  show("remote-first"); await until(() => f.requests.length === 1);
  await f.broker.respond({ requestId: f.requests[0].id, answers: { decision: "accept" } });
  client.send(JSON.stringify({ id: "remote-first", result: { decision: "decline" } }));
  await until(() => received.length === 1); await delay(50);
  assert.equal(received.length, 1); assert.equal(received[0].result.decision, "accept");
  show("native-first"); await until(() => f.requests.length === 1); const stale = f.requests[0].id;
  client.send(JSON.stringify({ id: "native-first", result: { decision: "decline" } }));
  await until(() => f.requests.length === 0);
  await assert.rejects(f.broker.respond({ requestId: stale, answers: { decision: "accept" } }), /expired/);
  show("resolved"); await until(() => f.requests.length === 1);
  upstream.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "resolved" } }));
  await until(() => f.requests.length === 0);
  show("disconnect"); await until(() => f.requests.length === 1); client.close(); await until(() => f.requests.length === 0);
});

test("Pi /compact uses the native operation and /model replies through the same menu broker", async () => {
  const f = brokerFixture(); let compact: any, status = "", model = "", current = true, idle = true;
  const ctx = { isIdle: () => idle, compact: (options: any) => { compact = options; },
    modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model" }] } };
  const api = { setModel: async (value: any) => { model = value.id; return true; } };
  const run = (text: string) => piCommand(text, ctx, api, f.broker, value => { status = value; }, () => current);
  assert.equal(await run("hello"), false); assert.equal(slashCommand("/path/to/file"), undefined);
  await run("/compact preserve decisions"); assert.equal(compact.customInstructions, "preserve decisions");
  assert.equal(status, "Compacting context…"); compact.onComplete(); assert.equal(status, "Context compacted.");
  await run("/model"); await f.broker.respond({ requestId: f.requests[0].id, answers: { model: "0" } }); assert.equal(model, "model");
  await run("/model"); idle = false;
  await assert.rejects(f.broker.respond({ requestId: f.requests[0].id, answers: { model: "0" } }), /busy/);
  await assert.rejects(run("/quit"), /not sent as a prompt/);
  await run("/compact"); current = false; compact.onError(new Error("private failure")); assert.equal(status, "Compacting context…");
});

test("Codex /compact cannot become a model prompt, unsupported slash commands send nothing, ordinary text still works", async () => {
  const requests: any[] = [];
  const send = async (method: string, params: unknown) => { requests.push({ method, params }); };
  await codexInput("/compact", "current", send);
  assert.deepEqual(requests, [{ method: "thread/compact/start", params: { threadId: "current" } }]);
  await assert.rejects(codexInput("/compact preserve tests", "current", send), /extra instructions/);
  await assert.rejects(codexInput("/model", "current", send), /not sent as a prompt/);
  assert.equal(requests.length, 1);
  await codexInput("continue", "current", send);
  assert.deepEqual(requests[1], { method: "turn/start", params: { threadId: "current", input: [{ type: "text", text: "continue" }] } });
});

test("phone API reaches Pi compact/model through native mailbox, requires control token and rejects another session", async t => {
  const root = await temp(t), directory = join(root, "native"), file = join(root, "saved.jsonl"), key = sessionKey(file);
  const oldData = process.env.EVEN_PILOT_DATA_DIR; process.env.EVEN_PILOT_DATA_DIR = root;
  const handlers = new Map<string, any>(); let sent = "", compactCalls = 0, complete: any;
  const ctx = { mode: "tui", cwd: root, isIdle: () => true, abort() {}, compact: (o: any) => { compactCalls++; complete = o.onComplete; },
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "m" }] },
    sessionManager: { getSessionFile: () => file, getSessionId: () => "native", getSessionName: () => "Fixture", getBranch: () => [] } };
  monitorPi({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: text => { sent = text; }, setModel: async () => true });
  handlers.get("session_start")({}, ctx);
  const host = new NativeHost({ cwd: root, directory, preferencesPath: join(root, "watch.json"), launch: async () => {}, alive: () => true });
  await host.start(); const journal = new NotificationJournal(host.store);
  const { server } = createBridgeServer(host, journal, { token: "control", notificationToken: "read-only", host });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await host.stop(); journal.close(); handlers.get("session_shutdown")();
    if (oldData === undefined) delete process.env.EVEN_PILOT_DATA_DIR; else process.env.EVEN_PILOT_DATA_DIR = oldData; });
  const post = (path: string, body: any, token = "control") => fetch("http://127.0.0.1:" + (server.address() as any).port + path, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await post("/api/prompt", { sessionKey: key, text: "/compact" })).status, 202);
  assert.equal(compactCalls, 1); assert.equal(sent, "");
  await until(() => host.store.state.commandStatus === "Compacting context…"); complete();
  await until(() => host.store.state.commandStatus === "Context compacted.");
  assert.equal((await post("/api/prompt", { sessionKey: key, text: "/model" })).status, 202);
  await until(() => !!host.store.state.interactions?.length);
  const answer = { sessionKey: key, requestId: host.store.state.interactions![0].id, answers: { model: "0" } };
  assert.equal((await post("/api/interaction/respond", answer, "read-only")).status, 403);
  assert.equal((await post("/api/interaction/respond", { ...answer, sessionKey: "other" })).status, 409);
  assert.equal((await post("/api/interaction/respond", answer)).status, 200);
  await until(() => host.store.state.interactions?.length === 0);
  assert.equal((await post("/api/interaction/respond", answer)).status, 400);
  assert.equal(journal.list().length, 0, "Menu actions must not fake a completed agent run");
});

test("Claude relays permission decisions over its official channel and clears locally resolved choices", async t => {
  const root = await temp(t), run = join(root, "run"); await mkdir(run); const id = randomUUID();
  const { rpc, child } = stdioRpc({ command: process.execPath, args: ["--import", "tsx"] },
    [resolve("apps/windows/src/connectors/claude-channel.ts"), root, run, root, id]);
  t.after(async () => { const exited = once(child, "exit"); rpc.close(); await exited; });
  const init = await rpc.request("initialize", {}); assert.deepEqual(init.capabilities.experimental["claude/channel/permission"], {});
  rpc.notify("notifications/initialized"); const path = join(root, "native", child.pid + ".json");
  await until(() => { try { return readLocalJson(path).state.connected; } catch { return false; } });
  const methods: any[] = []; rpc.on("event", m => methods.push(m));
  const show = () => rpc.notify("notifications/claude/channel/permission_request", { request_id: "abcde", tool_name: "Bash", description: "Run echo?", input_preview: '{"command":"echo hello"}' });
  show(); await until(() => readLocalJson(path).state.interactions?.length === 1);
  let snapshot = readLocalJson(path); const reply = randomUUID();
  writeLocalJson(join(root, "native", snapshot.instance + ".command.json"), { id: reply, type: "respond", instance: snapshot.instance,
    key: snapshot.state.session.key, expiresAt: Date.now() + 5000, answer: { requestId: snapshot.state.interactions[0].id, answers: { decision: "deny" } } });
  await until(() => methods.some(m => m.method === "notifications/claude/channel/permission"));
  assert.deepEqual(methods.find(m => m.method === "notifications/claude/channel/permission").params, { request_id: "abcde", behavior: "deny" });
  assert(!methods.some(m => m.method === "notifications/claude/channel"));
  await until(() => readLocalJson(path).state.interactions?.length === 0); show();
  await until(() => readLocalJson(path).state.interactions?.length === 1);
  const endpoint = readLocalJson(join(run, "endpoint.json"));
  await fetch("http://127.0.0.1:" + endpoint.port + "/event", { method: "POST", headers: { Authorization: "Bearer " + endpoint.token }, body: JSON.stringify({ session_id: id, hook_event_name: "PreToolUse", tool_name: "Bash" }) });
  await until(() => readLocalJson(path).state.interactions?.length === 0);
});

test("G2 choices use SDK taps immediately and reject expired or disconnected selection", async t => {
  let body = "", replies: any[] = [];
  const display = new G2Display((_, text) => { body = text; }, () => {}, undefined, { respond: async (key, answer) => { replies.push({ key, answer }); } });
  t.after(() => display.dispose());
  const choice: Interaction = { ...request, id: "choice", expiresAt: Date.now() + 10_000 };
  const state = { ...initialState(), connected: true, session: { key: "session", cwd: "" }, interactions: [choice] };
  display.update(state, true); assert.match(body, /Which option/); display.scroll(1); assert.match(body, /2\/2 Yes/);
  display.handleEvent({ textEvent: { eventType: 3 } } as any);
  assert.equal(replies.length, 0); assert.match(body, /^> New prompt\n/);
  await delay(120); display.toggle(); display.handleEvent({ textEvent: { eventType: 0 } } as any); await delay(120);
  assert.equal(replies.length, 1); assert.deepEqual(replies[0].answer.answers, { q: "yes" });
  display.update({ ...state, interactions: [{ ...choice, id: "second", expiresAt: Date.now() - 1 }] }, true);
  display.handleEvent({ textEvent: { eventType: 0 } } as any);
  display.update({ ...state, interactions: [{ ...choice, id: "third" }] }, true); await delay(120);
  assert.equal(replies.length, 1);
  display.update({ ...state, interactions: [{ ...choice, id: "third" }] }, false); display.toggle(); await delay(20);
  assert.equal(replies.length, 1);
  const large = { ...choice, id: "large", detail: "Long approval details ".repeat(30) };
  assert.equal(glassesInteraction(large), false);
  display.update({ ...state, interactions: [large] }, true); assert.match(body, /answer on phone/); display.toggle(); await delay(20);
  assert.equal(replies.length, 1);
});
