import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { readdirSync, unlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { ConnectorMonitor } from "../../../../packages/connectors/monitor.js";
import { connectorKey } from "../../../../packages/connectors/identity.js";
import { ClaudeEvents } from "../../../../packages/connectors/claude-events.js";
import { claudeHistory } from "../../../../packages/connectors/catalog.js";
import { canonicalPath } from "../../../../packages/pi-runtime/sessions.js";
import { writeLocalJson, readLocalJson, type NativeCommand } from "../../../../packages/pi-runtime/native-protocol.js";
import { G2_SUMMARY_OPEN, G2_SUMMARY_CLOSE } from "../../../../packages/cockpit-state/g2-reply.js";
import { claudeInterruptAvailable, validClaudeOwner, hasClaudeInterruption, interruptClaude } from "./claude-interrupt.js";
import { slashCommand, unsupportedCommand } from "../../../../packages/connectors/slash-commands.js";
import { ClaudeQuestionRelay } from "./claude-question-relay.js";

const [data, runDirectory, cwd, initialId] = process.argv.slice(2);
let id = initialId;
if (!data || !runDirectory || !cwd || !id) throw new Error("Missing Claude connector configuration");
const token = randomBytes(32).toString("base64url");
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let ready = false, transcriptPath: string | undefined, modified = 0, reading = false;
let stopRequest: { instance: string; runId: number; at: number } | undefined;
const monitor = new ConnectorMonitor(join(data, "native"), { key: connectorKey("claude", id), id, cwd, tunnel: "claude" }, {
  prompt: async text => {
    const command = slashCommand(text); if (command) unsupportedCommand(command.name);
    if (!ready) throw new Error("Enable the Even-Pilot channel in this Claude terminal first");
    const intendedInstance = monitor.snapshot.instance, intendedId = id;
    drainEvents();
    if (monitor.snapshot.instance !== intendedInstance || id !== intendedId)
      throw new Error("Claude's current session changed. Prompt was not sent.");
    if (["running", "waiting"].includes(monitor.store.state.main.status))
      throw new Error("Claude is working; wait before sending another prompt");
    send({ jsonrpc: "2.0", method: "notifications/claude/channel", params: {
      content: text, meta: { session_id: id, source: "even-pilot", reply_to: "g2" },
    } });
    monitor.begin(); monitor.store.dispatch({ type: "user.message", text });
  },
  ...(claudeInterruptAvailable() ? { interrupt: async (command: NativeCommand) => {
    drainEvents();
    if (command.instance !== monitor.snapshot.instance || command.key !== monitor.store.state.session.key
      || command.runId !== monitor.snapshot.runId) throw new Error("Claude's current instruction changed. Stop was not sent.");
    if (!ready || !["running", "waiting"].includes(monitor.store.state.main.status)) throw new Error("Claude is not running");
    const { instance, runId } = monitor.snapshot;
    if (stopRequest?.instance === instance && stopRequest.runId === runId)
      throw new Error("Stop was already requested. Check Claude's terminal before trying again.");
    // No retry: an unconfirmed helper may already have delivered its Escape.
    stopRequest = { instance, runId, at: Date.now() };
    monitor.publish();
    await interruptClaude(runDirectory, join(data, "native", monitor.snapshot.pid + ".json"), monitor.snapshot);
  } } : {}),
});
const events = new ClaudeEvents(monitor);
const questions = new ClaudeQuestionRelay(monitor);
function refreshOwner() {
  let supported = false;
  try {
    const owner = readLocalJson(join(runDirectory, "owner.json"));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      monitor.snapshot.terminalPid = owner.pid;
      supported = claudeInterruptAvailable() && validClaudeOwner(owner);
    }
  } catch {}
  monitor.store.state.capabilities = { interrupt: supported };
}
refreshOwner();
const seenEvents = new Set<string>();
function accept(event: any) {
  if (event.eventId && seenEvents.has(event.eventId)) return;
  if (typeof event.session_id !== "string" || !/^[a-f0-9-]{16,64}$/i.test(event.session_id)) throw new Error("Invalid session");
  // Child hooks also carry their parent's session_id. Their lifecycle cannot
  // replace the main session, its transcript source or its approval requests.
  if (event.agent_id && ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure"].includes(event.hook_event_name)) return;
  if (event.session_id !== id) {
    if (event.hook_event_name !== "SessionStart" || typeof event.cwd !== "string") throw new Error("Session changed");
    id = event.session_id; modified = 0; transcriptPath = undefined; stopRequest = undefined;
    monitor.changeSession({ key: connectorKey("claude", id), id, cwd: event.cwd, tunnel: "claude" });
  }
  if (event.eventId) {
    seenEvents.add(event.eventId);
    if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value!);
  }
  if (!event.agent_id && typeof event.transcript_path === "string") transcriptPath = event.transcript_path;
  if (!event.agent_id && ["PreToolUse", "Stop", "SessionEnd", "UserPromptSubmit", "SessionStart"].includes(event.hook_event_name)) {
    questions.cancel(); monitor.interactions.clear();
  }
  events.receive(event);
}
function drainEvents() {
  const queue = join(runDirectory, "events");
  let names: string[];
  try { names = readdirSync(queue); } catch { return; }
  // Drain synchronously so HTTP delivery and the timer cannot interleave old
  // queued hooks with a new session. One malformed hook must not block others.
  for (const name of names.filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n)).sort()) {
    const path = join(queue, name);
    try { accept(readLocalJson(path)); } catch {}
    finally { try { unlinkSync(path); } catch {} }
  }
}
const http = createServer(async (req, res) => {
  const received = Buffer.from(req.headers.authorization || ""), expected = Buffer.from("Bearer " + token);
  if (req.method !== "POST" || !["/event", "/question"].includes(req.url || "") || received.length !== expected.length || !timingSafeEqual(received, expected)
    || req.headers.origin) { res.writeHead(403); res.end(); return; }
  try {
    let body = "";
    for await (const part of req) { body += part; if (body.length > 256_000) throw new Error("Too large"); }
    const event = JSON.parse(body);
    drainEvents();
    accept(event);
    if (req.url === "/question") {
      if (!ready || !questions.handle(event, res)) { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end("{}"); }
    } else { res.writeHead(204); res.end(); }
  } catch { res.writeHead(400); res.end(); }
});
http.headersTimeout = 5000; http.requestTimeout = 5000;
await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
writeLocalJson(join(runDirectory, "endpoint.json"), { port: (http.address() as { port: number }).port, token });

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  if (line.length > 256_000) return;
  let message: any; try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const respond = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") respond({ protocolVersion: message.params?.protocolVersion || "2024-11-05",
    serverInfo: { name: "even-pilot", version: "1.1.2" },
    capabilities: { experimental: { "claude/channel": {}, "claude/channel/permission": {} }, tools: {} },
    instructions: "Even-Pilot forwards the user's G2 prompts to this same session. Respond normally in the terminal. Preserve requested <g2-summary> summary markers. The reply tool may additionally send a concise glasses reply; it does not replace the full terminal response.",
  });
  else if (message.method === "notifications/initialized") { ready = true; drainEvents(); refreshOwner(); monitor.start(); }
  else if (message.method === "notifications/claude/channel/permission_request" && ready) {
    const p = message.params;
    if (!p || typeof p.request_id !== "string" || !/^[a-km-z]{5}$/.test(p.request_id)
      || [p.tool_name, p.description, p.input_preview].some(value => typeof value !== "string")) return;
    const instance = monitor.snapshot.instance, run = monitor.snapshot.runId;
    try {
      monitor.interactions.add("claude:" + p.request_id, { kind: "approval", title: "Claude · " + p.tool_name,
        detail: p.input_preview, questions: [{ id: "decision", text: p.description,
          options: [{ id: "deny", label: "Deny" }, { id: "allow", label: "Allow once" }] }],
      }, async answer => {
        if (!ready || instance !== monitor.snapshot.instance || run !== monitor.snapshot.runId)
          throw new Error("Claude's current request changed");
        send({ jsonrpc: "2.0", method: "notifications/claude/channel/permission",
          params: { request_id: p.request_id, behavior: answer.answers.decision } });
      });
    } catch { /* Oversize/unsupported prompts remain in the native terminal. */ }
  }
  else if (message.method === "ping") respond({});
  else if (message.method === "tools/list") respond({ tools: [{
    name: "reply", description: "Send a concise reply to the user's Even-Pilot glasses for the current session.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  }] });
  else if (message.method === "tools/call" && message.params?.name === "reply") {
    const text = message.params?.arguments?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 32_000) respond({ isError: true, content: [{ type: "text", text: "Invalid reply" }] });
    else {
      monitor.store.dispatch({ type: "assistant.completed", text: text.includes(G2_SUMMARY_OPEN) ? text : `${G2_SUMMARY_OPEN}\n${text}\n${G2_SUMMARY_CLOSE}` });
      monitor.activity(); respond({ content: [{ type: "text", text: "Displayed in Even-Pilot." }] });
    }
  } else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported" } });
});
const timer = setInterval(async () => {
  drainEvents();
  refreshOwner();
  if (!transcriptPath || reading || !ready) return;
  const sessionId = id, instance = monitor.snapshot.instance, source = transcriptPath;
  reading = true;
  try {
    const root = await realpath(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"));
    const path = await realpath(source);
    if (!canonicalPath(path).startsWith(canonicalPath(root) + sep) || !path.endsWith(sessionId + ".jsonl")) return;
    const info = await stat(path);
    if (info.mtimeMs === modified || info.size > 32 * 1024 * 1024) return;
    const sourceText = await readFile(path, "utf8");
    const history = claudeHistory(sourceText, path, info.mtimeMs);
    if (!history || monitor.snapshot.instance !== instance || transcriptPath !== source || !ready) return;
    modified = info.mtimeMs;
    monitor.store.dispatch({ type: "session.updated", session: {
      ...(history.session.name ? { name: history.session.name } : {}),
      ...(history.session.model ? { model: history.session.model } : {}),
    } });
    monitor.store.dispatch({ type: "session.history", transcript: history.messages.map((m, index) => ({ ...m, id: index, at: m.at || 0 })) });
    if (stopRequest?.instance === instance && stopRequest.runId === monitor.snapshot.runId
      && hasClaudeInterruption(sourceText, sessionId, stopRequest.at)) monitor.end("interrupted");
    monitor.activity();
  } catch { /* Native transcript may be between writes; retry without changing run state. */ }
  finally { reading = false; }
}, 1000);
lines.on("close", () => { ready = false; questions.cancel(); clearInterval(timer); monitor.stop(); http.close(); });
