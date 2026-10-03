import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeLocalJson } from "../../../../packages/pi-runtime/native-protocol.js";
import { stopHookTrust } from "../claude-hook-trust.mjs";
import { claudeQuestions, claudeInteractionQuestions, claudeQuestionOutput } from "../../../../packages/connectors/claude-questions.js";
import { CLAUDE_QUESTION_TIMEOUT_MS } from "./claude-question-relay.js";

// Hooks must fail open: a stopped monitor cannot stall or reject native CLI work.
let event: Record<string, unknown> | undefined;
let output: ReturnType<typeof claudeQuestionOutput>;
try {
  let input = "";
  for await (const part of process.stdin) { input += part; if (input.length > 1_000_000) throw new Error("Hook input too large"); }
  const raw = JSON.parse(input);
  event = { eventId: randomUUID() };
  for (const key of ["hook_event_name", "session_id", "cwd", "transcript_path", "model", "prompt",
    "last_assistant_message", "agent_id", "tool_name", "tool_use_id"]) if (raw[key] !== undefined) event[key] = raw[key];
  if (raw.background_tasks !== undefined) {
    // Keep only bounded task identity/status. Descriptions and shell commands
    // can contain private data and are unnecessary for the completion guard.
    const tasks = raw.background_tasks;
    event.background_tasks = Array.isArray(tasks) ? [
      ...tasks.slice(0, 256).map(task => {
        const safe: Record<string, string> = {};
        for (const key of ["id", "type", "status"]) if (typeof task?.[key] === "string") safe[key] = task[key].slice(0, 128);
        return safe;
      }),
      ...(tasks.length > 256 ? [{ id: "unknown:overflow" }] : []),
    ] : [{ id: "unknown:registry" }];
  }
  if (raw.session_crons !== undefined) {
    // Cron prompts and expressions are private and unnecessary for liveness.
    const crons = raw.session_crons;
    event.session_crons = Array.isArray(crons) ? [
      ...crons.slice(0, 256).map(cron => ({
        ...(typeof cron?.id === "string" ? { id: cron.id.slice(0, 128) } : {}),
        ...(typeof cron?.recurring === "boolean" ? { recurring: cron.recurring } : {}),
      })),
      ...(crons.length > 256 ? [{ id: "unknown:overflow" }] : []),
    ] : [{ id: "unknown:registry" }];
  }
  if (["Stop", "SubagentStop"].includes(String(raw.hook_event_name))) {
    const runDirectory = resolve(process.argv[2]);
    const trust = await stopHookTrust({ eventName: String(raw.hook_event_name),
      cwd: typeof raw.cwd === "string" ? raw.cwd : process.cwd(), data: resolve(runDirectory, "../.."), runDirectory });
    event.stopTrusted = trust.trusted;
    if (trust.reason) event.stopTrustReason = trust.reason;
  }
  // Persist before delivery. Otherwise a slow/failed HTTP call can queue an
  // older SessionStart after a newer session's hooks have already arrived.
  writeLocalJson(join(process.argv[2], "events", Date.now() + "-" + event.eventId + ".json"), event);
  const endpoint = JSON.parse(await readFile(join(process.argv[2], "endpoint.json"), "utf8"));
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== "string") throw new Error("Invalid hook endpoint");
  const questions = raw.hook_event_name === "PreToolUse" && raw.tool_name === "AskUserQuestion" && !raw.agent_id
    ? claudeQuestions(raw.tool_input) : undefined;
  const question = questions && !!claudeInteractionQuestions(questions);
  const response = await fetch("http://127.0.0.1:" + endpoint.port + (question ? "/question" : "/event"), {
    method: "POST", headers: { Authorization: "Bearer " + endpoint.token, "Content-Type": "application/json" },
    body: JSON.stringify(question ? { ...event, question_input: { questions } } : event),
    signal: AbortSignal.timeout(question ? CLAUDE_QUESTION_TIMEOUT_MS : 900), redirect: "error",
  });
  if (!response.ok) throw new Error("Hook receiver unavailable");
  if (question) {
    const text = await response.text();
    if (text.length > 40_000) throw new Error("Question answer too large");
    output = claudeQuestionOutput({ questions }, JSON.parse(text).answers);
  }
} catch {
  // The queued event survives MCP startup and uncertain HTTP acknowledgements.
}
process.stdout.write(JSON.stringify(output || {}) + "\n");
