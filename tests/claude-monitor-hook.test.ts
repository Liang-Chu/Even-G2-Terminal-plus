import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const modulePath = resolve("apps/windows/src/claude-monitor-hook.mjs");
const { sanitizeClaudeHook, runClaudeMonitorHook, discoverClaudeOwner, linuxProcessRecord, writeClaudeHookEvent, readClaudeHookGap, noteClaudeHookGap } = await import(pathToFileURL(modulePath).href);
async function fixture(t: any) {
  const data = await mkdtemp(join(tmpdir(), "pilot-claude-hook-")); t.after(() => rm(data, { recursive: true, force: true })); return data;
}
const input = (hook_event_name = "Stop", extra: object = {}) => ({ session_id: randomUUID(), hook_event_name,
  transcript_path: "/fixture/profile/projects/a/session.jsonl", cwd: "/fixture/project", ...extra });
async function invoke(data: string, body: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(process.execPath, [modulePath, data], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {}); child.stdin.end(body);
  const [code] = await once(child, "exit"); return { code, stdout, stderr };
}

test("Claude hook metadata is whitelisted and conversational text is byte bounded", () => {
  const value = sanitizeClaudeHook(input("Stop", { prompt: "中".repeat(20_000), last_assistant_message: "done",
    model: "claude-fixture", session_title: "Fixture title", agent_id: "worker", stop_hook_active: true, tool_input: { api_key: "PRIVATE" },
    error_details: "PRIVATE", api_key: "PRIVATE", background_tasks: [{ id: "1", type: "shell", status: "running", command: "PRIVATE", description: "PRIVATE" }],
    session_crons: [{ id: "2", recurring: true, prompt: "PRIVATE", schedule: "PRIVATE" }] }));
  assert.equal(value.version, 1); assert.ok(Buffer.byteLength(value.prompt) <= 32_000);
  assert.equal(value.prompt.includes("\uFFFD"), false); assert.equal(value.stop_hook_active, true);
  assert.equal(value.session_title, "Fixture title");
  assert.deepEqual(value.background_tasks, [{ id: "1", type: "shell", status: "running" }]);
  assert.deepEqual(value.session_crons, [{ id: "2", recurring: true }]);
  assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
  for (const bad of [null, [], input("Unknown"), input("Stop", { session_id: "../session" }), input("Stop", { cwd: "bad\0value" })])
    assert.equal(sanitizeClaudeHook(bad), undefined);
  assert.deepEqual(sanitizeClaudeHook(input("Stop", { background_tasks: "unavailable" })).background_tasks, [{ id: "unknown:registry" }]);
  assert.deepEqual(sanitizeClaudeHook(input("Stop", { background_tasks: [null, { description: "PRIVATE" }] })).background_tasks, [{}, {}]);
  const overflow = sanitizeClaudeHook(input("Stop", { background_tasks: Array.from({ length: 129 }, () => ({ id: "task", type: "shell", status: "running" })) }));
  assert.equal(overflow.background_tasks.length, 129); assert.deepEqual(overflow.background_tasks.at(-1), { id: "unknown:overflow" });
  assert.deepEqual(sanitizeClaudeHook(input("Stop", { session_crons: "unavailable" })).session_crons, [{ id: "unknown:registry" }]);
  assert.deepEqual(sanitizeClaudeHook(input("Stop", { session_crons: [null, { prompt: "PRIVATE" }] })).session_crons, [{}, {}]);
  const cronOverflow = sanitizeClaudeHook(input("Stop", { session_crons: Array.from({ length: 129 }, () => ({ id: "cron", recurring: true })) }));
  assert.equal(cronOverflow.session_crons.length, 129); assert.deepEqual(cronOverflow.session_crons.at(-1), { id: "unknown:overflow" });
});

test("standalone hook writes private independent files and skips connector sessions", async t => {
  const data = await fixture(t), owner = { pid: 123, started: "12345678" };
  for (const name of ["UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"])
    assert.equal(await runClaudeMonitorHook(data, { input: input(name), env: {}, discoverOwner: async () => owner,
      stopTrust: async () => ({ trusted: true }) }), true);
  const entries = await readdir(join(data, "claude-events")); assert.equal(entries.length, 5);
  for (const file of entries) {
    assert.match(file, /^\d+-[a-f0-9-]{36}\.json$/);
    const value = JSON.parse(await readFile(join(data, "claude-events", file), "utf8")); assert.deepEqual(value.owner, owner);
    if (["Stop", "SubagentStop"].includes(value.hook_event_name)) assert.equal(value.stopTrusted, true);
  }
  assert.equal(await runClaudeMonitorHook(data, { input: input(), env: { EVEN_PILOT_CLAUDE_CONNECTOR: "1" },
    discoverOwner: async () => { throw new Error("must not discover"); } }), false);
  assert.equal((await readdir(join(data, "claude-events"))).length, 5);
});

test("subprocess hook always exits zero with no decision on invalid, oversized and unavailable storage", async t => {
  const data = await fixture(t);
  for (const [destination, body] of [[data, "invalid"], [data, "x".repeat(300_000)], [join(data, "missing"), JSON.stringify(input())]]) {
    const result = await invoke(destination, body); assert.deepEqual(result, { code: 0, stdout: "{}\n", stderr: "" });
  }
  assert.equal(await runClaudeMonitorHook("", { input: input() }), false);
  assert.deepEqual(await invoke(data, JSON.stringify(input()), { ...process.env, EVEN_PILOT_CLAUDE_CONNECTOR: "1" }),
    { code: 0, stdout: "{}\n", stderr: "" });
});

test("queue cap prevents unbounded stopped-companion writes and ignores unsafe owner metadata", async t => {
  const data = await fixture(t), queue = join(data, "claude-events"); await mkdir(queue);
  await Promise.all(Array.from({ length: 1024 }, (_, index) => writeFile(join(queue, `${index}-${randomUUID()}.json`), "{}")));
  assert.equal(writeClaudeHookEvent(data, sanitizeClaudeHook(input()), { pid: 1, started: "1" }), false);
  assert.equal((await readdir(queue)).length, 1024);
  const empty = await fixture(t);
  assert.equal(writeClaudeHookEvent(empty, sanitizeClaudeHook(input()), { pid: -1, started: "secret" }), true);
  const file = (await readdir(join(empty, "claude-events")))[0];
  assert.equal(JSON.parse(await readFile(join(empty, "claude-events", file), "utf8")).owner, undefined);
});

test("a dropped child-start leaves a durable gap watermark on later accepted stops and prompts", async t => {
  const data = await fixture(t), queue = join(data, "claude-events"); await mkdir(queue);
  await Promise.all(Array.from({ length: 1024 }, (_, index) => writeFile(join(queue, `${index}-${randomUUID()}.json`), "{}")));
  const child = sanitizeClaudeHook(input("SubagentStart", { agent_id: "worker" }));
  assert.equal(writeClaudeHookEvent(data, child), false);
  const gap = readClaudeHookGap(data); assert.ok(gap.gapThrough >= child.at);
  const existing = await readdir(queue); await rm(join(queue, existing[0]));
  const stop = sanitizeClaudeHook(input("Stop")); assert.equal(writeClaudeHookEvent(data, stop), true);
  const accepted = JSON.parse(await readFile(join(queue, `${stop.at}-${stop.eventId}.json`), "utf8"));
  assert.equal(accepted.gapThrough, gap.gapThrough);
  await rm(join(queue, existing[1]));
  const prompt = sanitizeClaudeHook(input("UserPromptSubmit"), gap.gapThrough + 1); assert.equal(writeClaudeHookEvent(data, prompt), true);
  const resumed = JSON.parse(await readFile(join(queue, `${prompt.at}-${prompt.eventId}.json`), "utf8"));
  assert.ok(resumed.at > resumed.gapThrough, "A fresh turn can be distinguished from the affected turn");
  noteClaudeHookGap(data, gap.gapThrough - 1000); assert.ok(readClaudeHookGap(data).gapThrough >= gap.gapThrough);
});

test("body overflow and storage failure record gaps; malformed gap markers remain conservative", async t => {
  const data = await fixture(t), huge = sanitizeClaudeHook(input()); huge.prompt = "x".repeat(110_000);
  assert.equal(writeClaudeHookEvent(data, huge), false); assert.ok(readClaudeHookGap(data).gapThrough >= huge.at);
  await writeFile(join(data, "claude-monitor-gap.json"), "bad");
  const stop = sanitizeClaudeHook(input()); assert.equal(writeClaudeHookEvent(data, stop), true);
  const value = JSON.parse(await readFile(join(data, "claude-events", `${stop.at}-${stop.eventId}.json`), "utf8"));
  assert.equal(value.gapUnconfirmed, true);
  const blocked = await fixture(t); await writeFile(join(blocked, "claude-events"), "unrelated file");
  assert.equal(writeClaudeHookEvent(blocked, sanitizeClaudeHook(input("SubagentStart"))), false);
  assert.ok(readClaudeHookGap(blocked).gapThrough > 0);
});

test("untrusted Stop metadata is recorded conservatively without dropping the lifecycle event", async t => {
  const data = await fixture(t);
  assert.equal(await runClaudeMonitorHook(data, { input: input(), env: {}, discoverOwner: async () => undefined,
    stopTrust: async () => ({ trusted: false, reason: "other-stop-hooks" }) }), true);
  const files = await readdir(join(data, "claude-events"));
  const event = JSON.parse(await readFile(join(data, "claude-events", files[0]), "utf8"));
  assert.equal(event.stopTrusted, false); assert.equal(event.stopTrustReason, "other-stop-hooks");
  assert.equal(event.owner, undefined);
  let trustArgs: any;
  assert.equal(await runClaudeMonitorHook(data, { input: input(), env: {}, discoverOwner: async () => ({ pid: 123, started: "555", argv: ["claude", "--settings", "PRIVATE"] }),
    stopTrust: async (args: any) => { trustArgs = args; return { trusted: false }; } }), true);
  assert.deepEqual(trustArgs.argv, ["claude", "--settings", "PRIVATE"]);
  const all = await readdir(join(data, "claude-events"));
  for (const path of all) assert.equal((await readFile(join(data, "claude-events", path), "utf8")).includes("PRIVATE"), false);
});

test("Linux owner discovery traverses only bounded real ancestors and omits uncertain identity", async () => {
  const records: Record<number, object> = { 10: { parent: 9, started: "222", claude: false },
    9: { parent: 8, started: "111", claude: true } };
  assert.deepEqual(await discoverClaudeOwner({ platform: "linux", parentPid: 10, record: (pid: number) => records[pid] }),
    { pid: 9, started: "111" });
  assert.equal(await discoverClaudeOwner({ platform: "linux", parentPid: 10, record: () => undefined }), undefined);
  assert.equal(await discoverClaudeOwner({ platform: "linux", parentPid: 10, record: () => ({ parent: 10, started: "111", claude: false }) }), undefined);
  assert.equal(await discoverClaudeOwner({ platform: "linux", parentPid: 10, record: (pid: number) => pid === 10
    ? { parent: 9, started: "111", claude: false } : { parent: 8, started: "222", claude: true } }), undefined,
    "A parent born later than its supposed child is a reused PID");
});

test("Linux process record recognizes native/npm Claude and rejects unrelated or different-user fixtures", async t => {
  const data = await fixture(t), proc = join(data, "123"); await mkdir(proc);
  const fields = Array.from({ length: 20 }, () => "0"); fields[0] = "S"; fields[1] = "99"; fields[19] = "555";
  await writeFile(join(proc, "stat"), "123 (node (worker)) " + fields.join(" "));
  await writeFile(join(proc, "cmdline"), "/usr/bin/node\0/opt/node_modules/@anthropic-ai/claude-code/cli.js\0--model\0PRIVATE\0");
  const uid = process.getuid?.();
  // Windows fixture files carry uid 0, matching an explicit uid for this pure parser fixture.
  const expectedUid = uid === undefined ? 0 : uid;
  assert.deepEqual(linuxProcessRecord(123, data, expectedUid), { pid: 123, parent: 99, started: "555", claude: true });
  assert.equal(linuxProcessRecord(123, data, expectedUid + 1), undefined);
  await writeFile(join(proc, "cmdline"), "/usr/bin/node\0/fixture/claude-monitor-hook.mjs\0");
  assert.equal(linuxProcessRecord(123, data, expectedUid).claude, false);
  await writeFile(join(proc, "stat"), "123 (claude) " + fields.join(" ")); await writeFile(join(proc, "cmdline"), "/home/user/.local/bin/claude\0");
  assert.equal(linuxProcessRecord(123, data, expectedUid).claude, true);
});
