import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ConnectorMonitor } from "../packages/connectors/monitor.js";
import { ClaudeQuestionRelay } from "../apps/windows/src/connectors/claude-question-relay.js";
import { claudeHookSettings } from "../apps/windows/src/connectors/claude-terminal.js";
import { stdioRpc } from "../packages/connectors/rpc.js";
import { readLocalJson, writeLocalJson } from "../packages/pi-runtime/native-protocol.js";

const questionInput = { questions: [{ question: "Which format?", header: "Format", multiSelect: false,
  options: [{ label: "Summary", description: "Short reply" }, { label: "Full", description: "All details" }] }] };
async function until(check: () => boolean) { const end = Date.now() + 7000; while (!check()) { if (Date.now() > end) throw new Error("Question fixture timeout"); await delay(15); } }
async function fixture(t: any, timeout = 1000) {
  const root = await mkdtemp(join(tmpdir(), "pilot-claude-questions-")), id = randomUUID();
  const monitor = new ConnectorMonitor(root, { key: "c", id, cwd: root, tunnel: "claude" }, { prompt: async () => assert.fail("Question must not be sent as a new prompt") });
  monitor.begin();
  const relay = new ClaudeQuestionRelay(monitor, timeout);
  const event = { hook_event_name: "PreToolUse", session_id: id, tool_use_id: "toolu_fixture", tool_name: "AskUserQuestion", question_input: questionInput };
  let arrived!: () => void;
  const arrival = new Promise<void>(done => { arrived = done; });
  const server = createServer((_request, response) => { if (!relay.handle(event, response)) response.end("{}"); arrived(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { relay.cancel(); monitor.stop(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, {recursive:true,force:true,maxRetries:5}); });
  return { root, monitor, relay, event, arrival, url: "http://127.0.0.1:" + (server.address() as any).port };
}

test("connector questions map exact option/text answers once and cannot become new prompts", async t => {
  const f = await fixture(t);
  const pending = fetch(f.url); await until(() => !!f.monitor.store.state.interactions?.length);
  assert.equal(f.monitor.store.state.main.status, "waiting");
  const request = f.monitor.store.state.interactions![0];
  await f.monitor.interactions.respond({ requestId: request.id, answers: { q0: "choice:1" } });
  assert.deepEqual(await (await pending).json(), { answers: { "Which format?": "Full" } });
  await assert.rejects(f.monitor.interactions.respond({ requestId: request.id, answers: { q0: "choice:0" } }), /expired/);
  assert.equal(f.monitor.store.state.main.status, "running"); assert.equal(f.monitor.snapshot.completions.length, 0);
  f.event.tool_use_id = "toolu_text";
  const text = fetch(f.url); await until(() => !!f.monitor.store.state.interactions?.length);
  await f.monitor.interactions.respond({ requestId: f.monitor.store.state.interactions![0].id, answers: { q0: "Custom answer" } });
  assert.deepEqual(await (await text).json(), { answers: { "Which format?": "Custom answer" } });
});

test("phone Cancel immediately returns to native question without answering or completing", async t => {
  const f = await fixture(t), pending = fetch(f.url); await f.arrival;
  const request = f.monitor.store.state.interactions![0]; assert.equal(request.cancelable, true);
  await f.monitor.interactions.respond({ requestId: request.id, answers: {}, cancel: true });
  assert.deepEqual(await (await pending).json(), {});
  assert.equal(f.monitor.store.state.interactions?.length, 0);
  assert.equal(f.monitor.store.state.main.status, "waiting", "Only native lifecycle can resume or settle this work");
  assert.equal(f.monitor.snapshot.completions.length, 0);
  await assert.rejects(f.monitor.interactions.respond({ requestId: request.id, answers: {}, cancel: true }), /expired/);
});

test("connector question timeout/cancel/disconnect release requests with no native decision", async t => {
  for (const mode of ["timeout", "cancel", "disconnect"] as const) {
    const f = await fixture(t, mode === "timeout" ? 30 : 1000), controller = new AbortController();
    const pending = fetch(f.url, { signal: controller.signal });
    const aborted = mode === "disconnect" ? assert.rejects(pending) : undefined;
    await f.arrival;
    if (mode === "cancel") f.relay.cancel();
    if (mode === "disconnect") { controller.abort(); await aborted; }
    else assert.deepEqual(await (await pending).json(), {});
    await until(() => !f.monitor.store.state.interactions?.length);
    assert.equal(f.monitor.snapshot.completions.length, 0, "Fallback cannot fabricate a completed task");
  }
});

test("a changed connector session or run cannot receive an old question answer", async t => {
  const f = await fixture(t), pending = fetch(f.url); await until(() => !!f.monitor.store.state.interactions?.length);
  const request = f.monitor.store.state.interactions![0]; f.monitor.snapshot.runId++;
  await assert.rejects(f.monitor.interactions.respond({ requestId: request.id, answers: { q0: "choice:0" } }), /changed/);
  assert.deepEqual(await (await pending).json(), {});
});

test("only the opted-in AskUserQuestion hook gets a long timeout; unsupported questions stay native", async t => {
  const settings = claudeHookSettings("owned-command");
  const groups = settings.hooks.PreToolUse;
  assert.equal(groups.find(group => group.matcher === "AskUserQuestion")!.hooks[0].timeout, 310);
  const normal = groups.find(group => group.matcher !== "AskUserQuestion")!;
  assert.equal(normal.hooks[0].timeout, 2);
  assert.equal(new RegExp(normal.matcher!).test("AskUserQuestion"), false); assert.equal(new RegExp(normal.matcher!).test("Bash"), true);
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 2);
  const f = await fixture(t);
  for (const bad of [ { tool_name: "Bash" }, { session_id: randomUUID() }, { agent_id: "child" },
    { question_input: { questions: [{ ...questionInput.questions[0], multiSelect: true }] } }, { question_input: { questions: [] } } ]) {
    assert.equal(f.relay.handle({ ...f.event, ...bad }, { destroyed: false } as any), false);
  }
  assert.equal(f.monitor.store.state.interactions?.length || 0, 0);
});

test("real connector hook round trip returns official updatedInput without a model run", async t => {
  const root = await mkdtemp(join(tmpdir(), "pilot-claude-hook-question-")), run = join(root, "run"), id = randomUUID(); await mkdir(run);
  const { rpc, child } = stdioRpc({ command: process.execPath, args: ["--import", "tsx"] },
    [resolve("apps/windows/src/connectors/claude-channel.ts"), root, run, root, id]);
  const hooks: ReturnType<typeof spawn>[] = [];
  t.after(async () => { for (const hook of hooks) if (hook.exitCode === null) hook.kill(); const exited = once(child, "exit"); rpc.close(); await exited; await rm(root, {recursive:true,force:true,maxRetries:5}); });
  await rpc.request("initialize", {}); rpc.notify("notifications/initialized");
  const path = join(root, "native", child.pid + ".json");
  await until(() => { try { return readLocalJson(path).state.connected; } catch { return false; } });
  const hook = spawn(process.execPath, ["--import", "tsx", resolve("apps/windows/src/connectors/claude-hook.ts"), run],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false }); hooks.push(hook);
  let output = ""; hook.stdout!.on("data", chunk => { output += chunk; }); hook.stderr!.resume();
  const exited = once(hook, "exit");
  hook.stdin!.end(JSON.stringify({ session_id: id, cwd: root, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_real_fixture", tool_input: questionInput }));
  await until(() => !!readLocalJson(path).state.interactions?.length);
  const snapshot = readLocalJson(path);
  writeLocalJson(join(root, "native", snapshot.instance + ".command.json"), { id: randomUUID(), type: "respond", instance: snapshot.instance,
    key: snapshot.state.session.key, expiresAt: Date.now() + 5000, answer: { requestId: snapshot.state.interactions[0].id, answers: { q0: "choice:0" } } });
  assert.equal((await exited)[0], 0);
  assert.deepEqual(JSON.parse(output).hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { questions: questionInput.questions, answers: { "Which format?": "Summary" } } });
  await until(() => readLocalJson(path).state.interactions.length === 0);
  assert.equal(readLocalJson(path).completions.length, 0);
});
