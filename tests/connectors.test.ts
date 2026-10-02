import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { ConnectorMonitor } from "../packages/connectors/monitor.js";
import { CodexEvents } from "../packages/connectors/codex-events.js";
import { ClaudeEvents } from "../packages/connectors/claude-events.js";
import { connectorKey } from "../packages/connectors/identity.js";
import { ConnectorCatalog, claudeHistory, codexHistory, readCodexHistory } from "../packages/connectors/catalog.js";
import { NativeHost } from "../packages/pi-runtime/native-host.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { writeLocalJson, readLocalJson } from "../packages/pi-runtime/native-protocol.js";
import { stdioRpc, AgentRpc } from "../packages/connectors/rpc.js";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { codexTerminalLink } from "../packages/connectors/codex-terminal-link.js";
import { sessionAgentCount } from "../packages/cockpit-state/selectors.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "even-connectors-"));
  await mkdir(join(root, "native")); await mkdir(join(root, "pi"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out"); await delay(30); }
}

test("mixed native sessions settle independently and keep Watch on disconnection", async t => {
  const root = await fixture(t), directory = join(root, "native");
  const host = new NativeHost({ cwd: root, directory, sessions: { root: join(root, "pi") },
    preferencesPath: join(root, "monitoring.json"), launch: async () => assert.fail("Live session must not launch"), alive: () => true });
  const journal = new NotificationJournal(host.store); t.after(() => { journal.close(); return host.stop(); });
  const make = (tunnel: "codex" | "claude", pid: number) => {
    const id = randomUUID();
    const monitor = new ConnectorMonitor(directory, { key: connectorKey(tunnel, id), id, cwd: root, tunnel, model: tunnel + "-test" }, { prompt: async () => {} });
    monitor.snapshot.pid = pid; monitor.publish(); return monitor;
  };
  const codex = make("codex", 101), claude = make("claude", 102);
  host.scan(); codex.begin(); claude.begin(); codex.publish(); claude.publish(); host.scan();
  assert.equal(host.store.state.monitoring?.running, 2);
  codex.child("worker", true); codex.end(); codex.publish(); host.scan();
  assert.equal(sessionAgentCount(codex.store.state, true), "1", "finished main is not an extra working agent");
  assert.equal(journal.list().length, 0);
  codex.child("worker", false); host.scan();
  assert.equal(journal.list().length, 1, "Codex notifies while Claude still runs");
  assert.equal(host.store.state.monitoring?.running, 1);
  claude.stop(); host.scan();
  assert.equal(journal.list().length, 1, "Disconnect never completes a turn");
  assert.equal(host.store.state.monitoring?.watched, 2);
  await host.setMonitored(codex.store.state.session.key!, false);
  codex.publish(); host.scan();
  assert.equal(host.getRuntime(codex.store.state.session.key!).store.state.connected, true);
  assert.equal(host.store.state.monitoring?.watched, 1);
  assert.deepEqual((await host.listSessions()).sessions.map(s => s.tunnel).sort(), ["claude", "codex"]);
});

test("connector commands are claimed once, bound to a session, and never replayed", async t => {
  const root = await fixture(t), id = randomUUID(), prompts: string[] = [];
  const monitor = new ConnectorMonitor(root, { id, key: connectorKey("claude", id), cwd: root, tunnel: "claude" },
    { prompt: async text => { prompts.push(text); } });
  const send = async (key: string, type = "prompt", expiresAt = Date.now() + 1000) => {
    writeLocalJson(join(root, monitor.snapshot.instance + ".command.json"), { id: "test", instance: monitor.snapshot.instance, key, type, text: "G2 prompt", expiresAt });
    await monitor.poll(); return readLocalJson(join(root, monitor.snapshot.instance + ".reply.json"));
  };
  assert.match((await send("wrong")).error, /Session changed/);
  assert.match((await send(monitor.store.state.session.key!, "prompt", 0)).error, /expired/);
  assert.equal((await send(monitor.store.state.session.key!)).error, undefined);
  await monitor.poll(); assert.deepEqual(prompts, ["G2 prompt"]);
  assert.match((await send(monitor.store.state.session.key!, "interrupt")).error, /Ctrl.C/);
});

test("Codex events preserve approval waiting, exact child counts and visible output only", async t => {
  const root = await fixture(t), id = randomUUID();
  const monitor = new ConnectorMonitor(root, { id, key: connectorKey("codex", id), cwd: root, tunnel: "codex" }, { prompt: async () => {} });
  const events = new CodexEvents(id, monitor);
  const emit = (method: string, params: any) => events.receive({ method, params: { threadId: id, ...params } });
  emit("turn/started", { turn: { id: "turn-1" } });
  emit("item/agentMessage/delta", { itemId: "answer", delta: "Visible" });
  emit("item/reasoning/textDelta", { delta: "SECRET REASONING" });
  emit("item/completed", { item: { id: "answer", type: "agentMessage", text: "Visible answer" } });
  emit("item/completed", { item: { id: "answer", type: "agentMessage", text: "Visible answer" } });
  events.receive({ method: "item/commandExecution/requestApproval", id: 77, params: { threadId: id } });
  assert.equal(monitor.store.state.main.status, "waiting");
  emit("item/completed", { item: { id: "spawn", type: "collabAgentToolCall", agentsStates: { child: { status: "running" } } } });
  emit("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  assert.equal(monitor.snapshot.completions.length, 0);
  events.receive({ method: "thread/status/changed", params: { threadId: "child", status: { type: "idle" } } });
  assert.equal(monitor.snapshot.completions.length, 1);
  assert.equal(monitor.store.state.subagents?.active, 0);
  assert.equal(monitor.store.state.transcript.filter(m => m.role === "assistant").length, 1);
  assert(!JSON.stringify(monitor.snapshot).includes("SECRET"));
});

test("Claude hook lifecycle excludes foreign sessions and waits for the last subagent", async t => {
  const root = await fixture(t), id = randomUUID();
  const monitor = new ConnectorMonitor(root, { id, key: connectorKey("claude", id), cwd: root, tunnel: "claude" }, { prompt: async () => {} });
  const events = new ClaudeEvents(monitor);
  const emit = (hook_event_name: string, rest: any = {}) => events.receive({ session_id: id, hook_event_name, ...rest });
  emit("UserPromptSubmit", { session_id: "someone-else", prompt: "Wrong" }); assert.equal(monitor.store.state.main.status, "idle");
  emit("UserPromptSubmit", { prompt: "Hello" }); emit("SubagentStart", { agent_id: "a" }); emit("SubagentStart", { agent_id: "a" });
  emit("PermissionRequest"); assert.equal(monitor.store.state.main.status, "waiting");
  emit("PreToolUse", { tool_use_id: "tool", tool_name: "Read" });
  emit("Stop", { last_assistant_message: "Done" }); assert.equal(monitor.snapshot.completions.length, 0);
  assert.equal(sessionAgentCount(monitor.store.state, true), "1");
  emit("SubagentStop", { agent_id: "a" }); assert.equal(monitor.snapshot.completions.length, 1);
  assert.equal(sessionAgentCount(monitor.store.state, true), "0");
  emit("SubagentStop", { agent_id: "a" }); assert.equal(monitor.snapshot.completions.length, 1);
  emit("UserPromptSubmit", { prompt: "Another" }); emit("SessionEnd");
  assert.equal(monitor.store.state.connected, false); assert.equal(monitor.snapshot.completions.length, 1);
});

test("catalog merges saved native sessions with namespaced identity and original-session routing", async t => {
  const root = await fixture(t), id = randomUUID(), claudeRoot = join(root, "claude"), project = join(claudeRoot, "project");
  await mkdir(project, { recursive: true });
  const content = [{ sessionId: id, cwd: root, type: "user", message: { role: "user", content: "Claude test" } },
    { sessionId: id, cwd: root, type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "Answer" }] } }];
  const file = join(project, id + ".jsonl");
  await writeFile(file, content.map(x => JSON.stringify(x)).join("\n"));
  const requests: string[] = [];
  const rpc = { close() {}, async request(method: string) {
    requests.push(method);
    if (method === "thread/list") return { data: [{ id, cwd: root, name: "Codex test", updatedAt: 100, turns: [] }] };
    if (method === "thread/read") return { thread: { id, cwd: root, updatedAt: 100 } };
    if (method === "thread/turns/list") return { data: [{ items: [{ type: "agentMessage", text: "Native answer" }] }] };
    throw new Error(method);
  } };
  const catalog = new ConnectorCatalog({ data: root, pi: { root: join(root, "pi") }, claudeRoot, codex: async () => rpc });
  const rows = (await catalog.list()).sessions;
  assert.equal(rows.length, 2); assert.notEqual(rows[0].key, rows[1].key);
  assert.equal((await catalog.original(connectorKey("claude", id))).fresh, false);
  assert.equal((await catalog.original(connectorKey("codex", id))).path, id);
  assert.equal((await catalog.history(connectorKey("codex", id))).messages[0].text, "Native answer");
  assert(!JSON.stringify(await catalog.history(connectorKey("claude", id))).includes("PRIVATE"));
  assert(!requests.includes("thread/resume"), "Reading never resumes a native session");
  assert.equal(await readFile(file, "utf8"), content.map(x => JSON.stringify(x)).join("\n"));
  await rm(file);
  await assert.rejects(catalog.history(connectorKey("claude", id)), /no longer exists/);
  await assert.rejects(catalog.original(connectorKey("claude", id)), /no longer exists/);
});

test("history adapters filter raw tools/reasoning and support old Codex history fallback", async () => {
  const id = randomUUID(), cwd = "C:\\project";
  assert.equal(claudeHistory(JSON.stringify({ sessionId: id, cwd, message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }] } }), id + ".jsonl", 0)?.messages.length, 0);
  assert.equal(codexHistory({ id, cwd, turns: [{ items: [{ type: "reasoning", text: "secret" }, { type: "agentMessage", text: "Hello" }] }] }).messages.length, 1);
  const history = await readCodexHistory({ request: async (method: string) => {
    if (method === "thread/turns/list") throw new Error("Not supported");
    return { thread: { id, cwd, turns: [{ items: [{ type: "agentMessage", text: "Legacy" }] }] } };
  } }, id);
  assert.equal(history.messages[0].text, "Legacy");
});

test("JSON-RPC disconnect rejects pending delivery without retrying or approving", async () => {
  const sent: any[] = [], rpc = new AgentRpc(line => sent.push(JSON.parse(line)), () => {});
  const pending = rpc.request("turn/start", { input: "test" });
  for (const raw of ["null", "[]", "true", "42", "\"text\"", "{broken"]) rpc.receive(raw);
  assert.equal(rpc.closed, false);
  rpc.receive(JSON.stringify({ id: "approval-1", method: "item/requestApproval", params: {} }));
  rpc.disconnect(); await assert.rejects(pending, /not confirmed/);
  assert.equal(sent.length, 1); assert.equal(sent[0].method, "turn/start");
});

test("real Claude channel process performs MCP handshake, hook auth and G2 command delivery", async t => {
  const root = await fixture(t), run = join(root, "run"), id = randomUUID();
  await mkdir(run);
  writeLocalJson(join(run, "events", Date.now() + "-" + randomUUID() + ".json"), {
    eventId: randomUUID(), session_id: id, hook_event_name: "SessionStart", cwd: root, model: "claude-fixture",
  });
  const script = fileURLToPath(new URL("../apps/windows/src/connectors/claude-channel.ts", import.meta.url));
  const { rpc, child } = stdioRpc({ command: process.execPath, args: ["--import", "tsx"] }, [script, root, run, root, id]);
  t.after(async () => { const exit = once(child, "exit"); rpc.close(); if (child.exitCode === null) await exit; });
  await rpc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  rpc.notify("notifications/initialized");
  const path = join(root, "native", child.pid + ".json");
  await until(async () => { try { return readLocalJson(path).state.connected; } catch { return false; } });
  const endpoint = readLocalJson(join(run, "endpoint.json"));
  const post = (token: string, event: any) => fetch("http://127.0.0.1:" + endpoint.port + "/event", {
    method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(event),
  });
  assert.equal((await post("wrong", {})).status, 403);
  let pushed: any;
  rpc.on("event", message => { if (message.method === "notifications/claude/channel") pushed = message.params; });
  const snapshot = readLocalJson(path);
  writeLocalJson(join(root, "native", snapshot.instance + ".command.json"), { id: "g2", instance: snapshot.instance,
    key: connectorKey("claude", id), type: "prompt", text: "G2 fixture prompt", expiresAt: Date.now() + 5000 });
  await until(() => !!pushed);
  assert.equal(pushed.content, "G2 fixture prompt"); assert.equal(pushed.meta.session_id, id);
  assert.equal((await post(endpoint.token, { session_id: id, hook_event_name: "Stop", last_assistant_message: "Fixture completed" })).status, 204);
  await until(() => readLocalJson(path).completions.length === 1);
  assert.equal(readLocalJson(path).state.currentAssistantText, "Fixture completed");
  await until(() => readLocalJson(path).state.session.model === "claude-fixture");
  const secondId = randomUUID();
  const delayedId = randomUUID();
  writeLocalJson(join(run, "events", "1-" + delayedId + ".json"), {
    eventId: delayedId, session_id: id, hook_event_name: "SessionStart", cwd: root,
  });
  assert.equal((await post(endpoint.token, { session_id: secondId, hook_event_name: "SessionStart", cwd: root, model: "claude-second" })).status, 204);
  await until(() => readLocalJson(path).state.session.id === secondId);
  assert.notEqual(readLocalJson(path).instance, snapshot.instance);
  assert.equal(readLocalJson(path).completions.length, 0);
  assert.equal((await post(endpoint.token, { session_id: id, hook_event_name: "Stop" })).status, 400);
  await delay(1100);
  assert.equal(readLocalJson(path).state.session.id, secondId, "An older queued SessionStart cannot undo /resume");
});

test("Codex terminal link keeps approvals intact, ignores helper threads and never retries commands", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const requests: any[] = [], selected: string[] = [], events: string[] = [];
  server.on("connection", socket => socket.on("message", raw => {
    const m = JSON.parse(raw.toString()); requests.push(m);
    if (m.method === "turn/start") socket.send(JSON.stringify({ id: m.id, error: { code: -32601, message: "Uncertain" } }));
    else if (m.method) socket.send(JSON.stringify({ id: m.id, result: { thread: { id: m.params.threadId } } }));
  }));
  const link = await codexTerminalLink("ws://127.0.0.1:" + (server.address() as any).port, "fixture-token",
    result => selected.push(result.thread.id), message => events.push(message.method));
  const client = new WebSocket(link.url, { headers: { Authorization: "Bearer fixture-token" } });
  t.after(() => { client.terminate(); link.close(); for (const socket of server.clients) socket.terminate(); server.close(); });
  await once(client, "open");
  client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "original", approvalPolicy: "on-request" } }));
  client.send(JSON.stringify({ id: 2, method: "thread/start", params: { threadId: "helper", ephemeral: true } }));
  client.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "original" } }));
  await until(() => requests.length === 3 && selected.length === 1);
  assert.deepEqual(selected, ["original"]);
  assert.equal(requests[0].params.approvalPolicy, "on-request");
  const upstream = [...server.clients][0];
  upstream.send(JSON.stringify({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "original" } }));
  await until(() => events.length === 1);
  assert.equal(requests.length, 3, "monitor never answers approvals or replays a turn");
  client.send(JSON.stringify({ id: "approval", result: { decision: "decline" } }));
  await until(() => requests.length === 4);
  assert.equal(requests[3].result.decision, "decline");
});

test("new Codex windows register their real native ID without creating a fake saved session", async t => {
  const root = await fixture(t), native = join(root, "native"), id = randomUUID();
  let created = false, launched = false;
  const catalog = { async list() { return { sessions: [], skipped: 0 }; },
    async create() { created = true; throw new Error("Must not precreate Codex"); },
    async original() { throw new Error("unused"); }, async history() { throw new Error("unused"); } };
  const host = new NativeHost({ cwd: root, directory: native, preferencesPath: join(root, "watch.json"), catalog, alive: () => true,
    unregistered: async () => true,
    launch: async (launchId, cwd, tunnel, fresh, name) => {
      assert.equal(tunnel, "codex"); assert.equal(fresh, true); assert.equal(name, "New work"); launched = true;
      const monitor = new ConnectorMonitor(native, { id, key: connectorKey("codex", id), cwd, tunnel }, { prompt: async () => {} });
      monitor.snapshot.launchId = launchId; monitor.publish();
    } });
  await host.start(); t.after(() => host.stop());
  await host.newSession({ cwd: root, tunnel: "codex", name: "New work" }); host.scan();
  assert.equal(created, false); assert.equal(launched, true);
  assert.equal(host.store.state.session.id, id);
  assert.equal(host.store.state.monitoring?.watched, 1);
});

test("Codex forwards native responses and approvals even if monitoring throws", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const response = '{ "id": 1, "result": {"thread":{"id":"native"}} }';
  const approval = '{"id":"approval","method":"item/commandExecution/requestApproval","params":{}}';
  server.on("connection", socket => socket.on("message", () => { socket.send(response); socket.send(approval); }));
  const fail = () => { throw new Error("Observer fixture failure"); };
  const link = await codexTerminalLink("ws://127.0.0.1:" + (server.address() as any).port, "fixture-token", fail, fail);
  const client = new WebSocket(link.url, { headers: { Authorization: "Bearer fixture-token" } });
  t.after(() => { client.terminate(); link.close(); for (const socket of server.clients) socket.terminate(); server.close(); });
  const received: string[] = [];
  client.on("message", raw => received.push(raw.toString()));
  await once(client, "open");
  client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "native" } }));
  await until(() => received.length === 2);
  assert.deepEqual(received, [response, approval]);
  assert.equal(client.readyState, WebSocket.OPEN);
});

test("an in-flight prompt acknowledgement remains with its original session", async t => {
  const root = await fixture(t), directory = join(root, "native");
  let finish!: () => void;
  const id = randomUUID(), second = randomUUID();
  const monitor = new ConnectorMonitor(directory, { key: connectorKey("codex", id), id, cwd: root, tunnel: "codex" },
    { prompt: () => new Promise<void>(resolve => { finish = resolve; }) });
  const instance = monitor.snapshot.instance;
  writeLocalJson(join(directory, instance + ".command.json"), { id: "old", instance, key: connectorKey("codex", id),
    type: "prompt", text: "test", expiresAt: Date.now() + 5000 });
  const pending = monitor.poll();
  monitor.changeSession({ key: connectorKey("codex", second), id: second, cwd: root, tunnel: "codex" });
  finish(); await pending;
  assert.equal(readLocalJson(join(directory, instance + ".reply.json")).id, "old");
  await assert.rejects(readFile(join(directory, monitor.snapshot.instance + ".reply.json")), { code: "ENOENT" });
});
