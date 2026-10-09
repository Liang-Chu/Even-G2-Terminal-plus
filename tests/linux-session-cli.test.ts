import test from "node:test";
import assert from "node:assert/strict";
import { runSessionCommand, sessionCommands, sessionHelp } from "../apps/linux/src/session-cli.js";
import type { SessionSummary } from "../packages/pi-runtime/sessions.js";
import { monitorRunning } from "../apps/linux/src/monitor-health.js";

const alpha = "abcdef12000000000000000000000001", beta = "abcdef12000000000000000000000002";
test("read-only monitor health tolerates shutdown socket resets without hiding authentication or persistent failures", async () => {
  let attempts = 0;
  const failure = (code: string) => new Error("fetch failed", { cause: { code } });
  assert.equal(await monitorRunning(async () => {
    if (++attempts === 1) throw failure("UND_ERR_SOCKET");
    throw failure("ECONNREFUSED");
  }, 1234), false);
  assert.equal(attempts, 2);
  attempts = 0;
  assert.equal(await monitorRunning(async () => {
    if (++attempts === 1) throw failure("ECONNRESET");
    return Response.json({ nativeTerminals: true });
  }, 1234), true);
  await assert.rejects(monitorRunning(async () => Response.json({}, { status: 401 }), 1234), /another bridge/);
  attempts = 0;
  await assert.rejects(monitorRunning(async () => { attempts++; throw failure("UND_ERR_SOCKET"); }, 1234), /fetch failed/);
  assert.equal(attempts, 3);
});
test("read-only monitor health waits for recognized lifecycle readiness and shutdown", async () => {
  const lifecycle = () => Response.json({ error: "Bridge is starting or shutting down; retry shortly" }, { status: 503 });
  let attempts = 0;
  assert.equal(await monitorRunning(async () => ++attempts < 3 ? lifecycle() : Response.json({ nativeTerminals: true }), 1234), true);
  assert.equal(attempts, 3);
  attempts = 0;
  assert.equal(await monitorRunning(async () => {
    if (++attempts === 1) return lifecycle();
    throw new Error("fetch failed", { cause: { code: attempts === 2 ? "UND_ERR_SOCKET" : "ECONNREFUSED" } });
  }, 1234), false);
  assert.equal(attempts, 3);
});
test("read-only lifecycle retries never hide authentication, unrelated services or persistent shutdown", async () => {
  for (const [status, body] of [
    [401, { error: "Bridge is starting or shutting down; retry shortly" }],
    [403, { error: "Bridge is starting or shutting down; retry shortly" }],
    [503, { error: "Service unavailable" }],
    [503, { error: "Bridge is starting or shutting down; retry shortly", unrelated: true }],
    [500, { error: "Bridge is starting or shutting down; retry shortly" }],
  ] as const) {
    let attempts = 0;
    await assert.rejects(monitorRunning(async () => { attempts++; return Response.json(body, { status }); }, 1234), /another bridge/);
    assert.equal(attempts, 1);
  }
  await assert.rejects(monitorRunning(async () => new Response("not JSON", { status: 503 }), 1234), /another bridge/);
  let attempts = 0;
  await assert.rejects(monitorRunning(async () => {
    attempts++;
    return Response.json({ error: "Bridge is starting or shutting down; retry shortly" }, { status: 503 });
  }, 1234), /still starting or shutting down.*no process was stopped/);
  assert(attempts > 1 && attempts <= 51);
});
const row = (key: string, name: string, updatedAt = 1000): SessionSummary => ({ key, id: key, name, updatedAt,
  cwd: "/work", messageCount: 1, runtimeStatus: "idle", owned: false, active: false, tunnel: "pi" });
function fixture(sessions = [row(alpha, "First"), { ...row(beta, "Second", 2000), monitored: true }]) {
  const calls: { path: string; body?: object; timeoutMs?: number }[] = [], lines: string[] = [];
  return { calls, lines, context: { write: (line: string) => { lines.push(line); }, cwd: "/work",
    request: async (path: string, body?: object, timeoutMs?: number) => {
      calls.push({ path, body, timeoutMs });
      return Response.json(path.startsWith("/api/sessions") ? { sessions, skipped: 0 } : { ok: true });
    } } };
}

test("headless session listing is read-only, newest first and safely renders terminal controls", async () => {
  const f = fixture([row(alpha, "old"), { ...row(beta, "new\u001b]52;clipboard\u0007", 2000), monitored: true }]);
  await runSessionCommand("sessions", [], f.context);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body, undefined);
  assert(f.lines[1].includes(beta), "Displayed key grows enough to disambiguate colliding prefixes");
  assert(!/[\u001b\u0007]/.test(f.lines.join("\n")));
  const json = fixture();
  await runSessionCommand("sessions", ["--watched", "--json"], json.context);
  assert.deepEqual(JSON.parse(json.lines[0]).sessions.map((s: SessionSummary) => s.key), [beta]);
});

test("watch/unwatch require an unambiguous key/title and never open or terminate a terminal", async () => {
  const f = fixture();
  await assert.rejects(runSessionCommand("watch", ["abcdef12"], f.context), /Ambiguous/);
  assert(f.calls.every(call => call.body === undefined));
  await runSessionCommand("watch", ["First"], f.context);
  assert.deepEqual(f.calls.at(-1), { path: `/api/runtime/${alpha}/monitor`, body: { monitored: true }, timeoutMs: 30000 });
  await runSessionCommand("unwatch", [beta], f.context);
  assert.deepEqual(f.calls.at(-1)?.body, { monitored: false });
  assert(f.calls.every(call => !/terminal|interrupt|shutdown/.test(call.path)));
  const duplicate = fixture([row(alpha, "same"), row(beta, "same")]);
  await assert.rejects(runSessionCommand("unwatch", ["same"], duplicate.context), /Ambiguous/);
});

test("watcher CLI exposes no prompt or task interruption commands", async () => {
  const f = fixture();
  assert(!sessionCommands.has("send") && !sessionCommands.has("interrupt"));
  assert(!/^\s+(send|interrupt)\s/m.test(sessionHelp));
  await assert.rejects(runSessionCommand("send", ["First", "hello"], f.context), /Invalid/);
  await assert.rejects(runSessionCommand("interrupt", ["First"], f.context), /Invalid/);
  assert.equal(f.calls.length, 0);
});

test("CLI does not retry an uncertain mutation and preserves bridge refusal errors", async () => {
  let writes = 0;
  const f = fixture();
  const context = { ...f.context, request: async (path: string, body?: object) => {
    if (body) { writes++; throw new Error("network disconnected"); }
    return f.context.request(path);
  } };
  await assert.rejects(runSessionCommand("watch", ["First"], context), /may have been accepted.*Nothing was resent/);
  assert.equal(writes, 1);
  await assert.rejects(runSessionCommand("watch", ["First"], { ...f.context,
    request: async (path, body) => body ? Response.json({ error: "Terminal is busy" }, { status: 409 }) : f.context.request(path),
  }), /Terminal is busy/);
  await assert.rejects(runSessionCommand("watch", ["First"], { ...f.context,
    request: async (path, body) => body ? new Response('{"accepted":') : f.context.request(path),
  }), /reply was incomplete.*Nothing was resent/);
});

test("invalid CLI inputs fail before contacting the bridge", async () => {
  const f = fixture();
  for (const [command, args] of [
    ["watch", []], ["unwatch", ["First", "Second"]], ["send", ["First", " "]],
    ["send", ["First", "x".repeat(32001)]], ["sessions", ["--name", "bad"]], ["new", ["unknown"]],
    ["new", ["pi", "--name", " "]], ["sessions", ["--typo"]],
  ] as [string, string[]][]) await assert.rejects(runSessionCommand(command, args, f.context));
  assert.equal(f.calls.length, 0);
});

test("select reuses the existing native-terminal API; new carries literal project/title", async () => {
  const f = fixture();
  await runSessionCommand("select", ["First"], f.context);
  assert.equal(f.calls.at(-1)?.path, `/api/runtime/${alpha}/terminal`);
  await runSessionCommand("new", ["codex", "--name", "literal; $(false)"], f.context);
  assert.equal(f.calls.at(-1)?.path, "/api/session/new");
  assert.equal((f.calls.at(-1)?.body as any).name, "literal; $(false)");
  await runSessionCommand("sessions", ["--help"], f.context);
  assert(f.lines.at(-1)?.includes("no browser required"));
});
