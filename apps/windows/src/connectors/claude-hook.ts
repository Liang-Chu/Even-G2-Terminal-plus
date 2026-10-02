import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeLocalJson } from "../../../../packages/pi-runtime/native-protocol.js";

// Hooks must fail open: a stopped monitor cannot stall or reject native CLI work.
let event: Record<string, unknown> | undefined;
try {
  let input = "";
  for await (const part of process.stdin) { input += part; if (input.length > 1_000_000) throw new Error("Hook input too large"); }
  const raw = JSON.parse(input);
  event = { eventId: randomUUID() };
  for (const key of ["hook_event_name", "session_id", "cwd", "transcript_path", "model", "prompt",
    "last_assistant_message", "agent_id", "tool_name", "tool_use_id"]) if (raw[key] !== undefined) event[key] = raw[key];
  // Persist before delivery. Otherwise a slow/failed HTTP call can queue an
  // older SessionStart after a newer session's hooks have already arrived.
  writeLocalJson(join(process.argv[2], "events", Date.now() + "-" + event.eventId + ".json"), event);
  const endpoint = JSON.parse(await readFile(join(process.argv[2], "endpoint.json"), "utf8"));
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== "string") throw new Error("Invalid hook endpoint");
  const response = await fetch("http://127.0.0.1:" + endpoint.port + "/event", {
    method: "POST", headers: { Authorization: "Bearer " + endpoint.token, "Content-Type": "application/json" },
    body: JSON.stringify(event), signal: AbortSignal.timeout(900), redirect: "error",
  });
  if (!response.ok) throw new Error("Hook receiver unavailable");
} catch {
  // The queued event survives MCP startup and uncertain HTTP acknowledgements.
}
process.stdout.write("{}\n");
