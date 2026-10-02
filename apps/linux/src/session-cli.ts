import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { SessionSummary } from "../../../packages/pi-runtime/sessions.js";

type Request = (path: string, body?: object, timeoutMs?: number) => Promise<Response>;
export const sessionCommands = new Set(["sessions", "watch", "unwatch", "select", "new", "send", "interrupt"]);
export const sessionHelp = `Session management (no browser required):
  sessions [--watched] [--cwd DIR] [--json]   List newest sessions first
  watch SESSION                            Monitor without opening a terminal
  unwatch SESSION                          Stop monitoring; keep the CLI running
  select SESSION                           Select and open/reuse its native terminal
  new pi|codex|claude [--cwd DIR] [--name TITLE]
  send SESSION "prompt"                    Send once to that specific session
  send SESSION --stdin                     Read a prompt from a pipe/file
  interrupt SESSION                        Request cancellation of the current run

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
    ? "Ambiguous session. Use a longer key from `even-pilot sessions --json`."
    : "Session not found. Run `even-pilot sessions` and use its key or exact title.");
  return matches[0];
}

export async function readPromptStdin(input: AsyncIterable<Buffer | string> = process.stdin): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 128_000) throw new Error("Prompt is too long (maximum 32,000 characters).");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runSessionCommand(command: string, args: string[], context: {
  request: Request; write: (line: string) => void; readStdin?: () => Promise<string>; cwd?: string;
}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    json: { type: "boolean" }, watched: { type: "boolean" }, cwd: { type: "string" },
    name: { type: "string" }, stdin: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { context.write(sessionHelp); return; }
  const allowed = command === "sessions" ? ["json", "watched", "cwd"] : command === "new" ? ["cwd", "name"] : command === "send" ? ["stdin"] : [];
  if (!sessionCommands.has(command) || Object.keys(values).some(key => !allowed.includes(key)))
    throw new Error("Invalid command/options. Run `even-pilot --help`.");
  const arity = command === "sessions" ? 0 : command === "send" && !values.stdin ? 2 : 1;
  if (positionals.length !== arity) throw new Error("Invalid arguments. Run `even-pilot --help`; quote titles and prompts containing spaces.");
  if (command === "new" && !["pi", "codex", "claude"].includes(positionals[0])) throw new Error("Choose pi, codex or claude.");
  if (values.name !== undefined && (!values.name.trim() || values.name.length > 128)) throw new Error("Name must be between 1 and 128 characters.");
  let prompt: string | undefined;
  if (command === "send") {
    prompt = values.stdin ? await (context.readStdin || (() => readPromptStdin()))() : positionals[1];
    if (!prompt.trim() || prompt.length > 32_000) throw new Error("Prompt must be between 1 and 32,000 characters.");
  }
  const api = async (path: string, body?: object): Promise<any> => {
    let response: Response;
    try { response = await context.request(path, body, 30_000); }
    catch {
      throw new Error(body
        ? "Connection lost; the operation may have been accepted. Check the native terminal and session state before retrying. Nothing was resent."
        : "Cannot reach the monitor. Run `even-pilot start`, then try again.");
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
    context.write("Terminal launch requested. Run `even-pilot sessions` after the CLI initializes; `tmux ls` lists headless terminals.");
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
  } else if (command === "send") {
    await api(endpoint + "/prompt", { text: prompt });
    context.write("Prompt accepted by this session; completion is reported separately.");
  } else {
    await api(endpoint + "/interrupt", {});
    context.write("Cancellation requested for this session. Native terminal remains open.");
  }
}
