import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { SessionSummary } from "../../../packages/pi-runtime/sessions.js";

type Request = (path: string, body?: object, timeoutMs?: number) => Promise<Response>;
export const sessionCommands = new Set(["sessions", "watch", "unwatch", "select", "new"]);
export const sessionHelp = `Session management (no browser required):
  sessions [--watched] [--cwd DIR] [--json]   List newest sessions first
  watch SESSION                            Monitor without opening a terminal
  unwatch SESSION                          Stop monitoring; keep the CLI running
  select SESSION                           Select and open/reuse its native terminal
  new pi|codex|claude [--cwd DIR] [--name TITLE]

SESSION is a unique key prefix (at least 6 characters) or an exact session title.
Use sessions --json for full keys and machine-readable output.
select/new use a normal terminal, or tmux on a headless host. Use tmux ls and
tmux attach -t NAME for native interaction; Ctrl+B, D detaches without stopping it.
Listing sessions does not reset Watch. A disconnected session stays watched.`;

const plain = (value: unknown) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
function identify(sessions: SessionSummary[], query: string) {
  const exact = sessions.find(session => session.key === query);
  if (exact) return exact;
  const matches = sessions.filter(session => session.name === query ||
    (/^[a-f0-9]{6,32}$/i.test(query) && session.key.startsWith(query.toLowerCase())));
  if (matches.length !== 1) throw new Error(matches.length
    ? "Ambiguous session. Use a longer key from `terminal-plus sessions --json`."
    : "Session not found. Run `terminal-plus sessions` and use its key or exact title.");
  return matches[0];
}

export async function runSessionCommand(command: string, args: string[], context: {
  request: Request; write: (line: string) => void; cwd?: string;
}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    json: { type: "boolean" }, watched: { type: "boolean" }, cwd: { type: "string" },
    name: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { context.write(sessionHelp); return; }
  const allowed = command === "sessions" ? ["json", "watched", "cwd"] : command === "new" ? ["cwd", "name"] : [];
  if (!sessionCommands.has(command) || Object.keys(values).some(key => !allowed.includes(key)))
    throw new Error("Invalid command/options. Run `terminal-plus --help`.");
  const arity = command === "sessions" ? 0 : 1;
  if (positionals.length !== arity) throw new Error("Invalid arguments. Run `terminal-plus --help`; quote titles containing spaces.");
  if (command === "new" && !["pi", "codex", "claude"].includes(positionals[0])) throw new Error("Choose pi, codex or claude.");
  if (values.name !== undefined && (!values.name.trim() || values.name.length > 128)) throw new Error("Name must be between 1 and 128 characters.");
  const api = async (path: string, body?: object): Promise<any> => {
    let response: Response;
    try { response = await context.request(path, body, 30_000); }
    catch {
      throw new Error(body
        ? "Connection lost; the operation may have been accepted. Check the native terminal and session state before retrying. Nothing was resent."
        : "Cannot reach the monitor. Run `terminal-plus start`, then try again.");
    }
    let result: any;
    try { result = await response.json(); }
    catch { throw new Error(body
      ? "Bridge reply was incomplete; the operation may have been accepted. Check the native terminal before retrying. Nothing was resent."
      : "Invalid reply from the monitor."); }
    if (!response.ok) throw new Error(plain(result.error || `Bridge returned HTTP ${response.status}`));
    return result;
  };
  if (command === "new") {
    await api("/api/session/new", { tunnel: positionals[0], cwd: resolve(values.cwd || context.cwd || process.cwd()), name: values.name });
    context.write("Terminal launch requested. Run `terminal-plus sessions` after the CLI initializes; `tmux ls` lists headless terminals.");
    return;
  }
  const catalog = await api("/api/sessions" + (command === "sessions" && values.cwd ? "?cwd=" + encodeURIComponent(resolve(values.cwd)) : ""));
  const sessions: SessionSummary[] = catalog.sessions;
  if (!Array.isArray(sessions)) throw new Error("Invalid session list from bridge.");
  if (command === "sessions") {
    const rows = sessions.filter(session => !values.watched || session.monitored)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    if (values.json) { context.write(JSON.stringify({ ...catalog, sessions: rows }, null, 2)); return; }
    context.write("KEY          WATCH  STATE     TUNNEL / MODEL / TITLE");
    for (const session of rows) {
      let length = 8;
      while (length < 32 && sessions.some(other => other.key !== session.key && other.key.startsWith(session.key.slice(0, length)))) length++;
      const key = session.key.slice(0, length);
      context.write(`${key.padEnd(12)} ${session.monitored ? "yes  " : "no   "}  ${plain(session.runtimeStatus || "offline").padEnd(9)} ${session.tunnel || "pi"} / ${plain(session.model || "?")} / ${plain(session.name || session.preview || "Untitled")}`);
      context.write(`             ${session.updatedAt ? new Date(session.updatedAt).toISOString() : "unknown update time"}  ${plain(session.cwd)}${session.active ? "  [selected]" : ""}`);
    }
    if (!rows.length) context.write("No sessions found.");
    if (catalog.skipped) context.write(`${catalog.skipped} unreadable session file(s) skipped.`);
    return;
  }
  const session = identify(sessions, positionals[0]);
  const endpoint = "/api/runtime/" + session.key;
  if (command === "watch" || command === "unwatch") {
    await api(endpoint + "/monitor", { monitored: command === "watch" });
    context.write(`${command === "watch" ? "Watching" : "Unwatched"}: ${plain(session.name || session.key)}. Native terminal unchanged.`);
  } else if (command === "select") {
    await api(endpoint + "/terminal", {});
    context.write(`Selected: ${plain(session.name || session.key)}. Terminal opened/reused and watched. Use tmux ls / tmux attach on a headless host.`);
  }
}
