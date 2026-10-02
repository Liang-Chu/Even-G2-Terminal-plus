import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { AgentStatus, Tunnel } from "../cockpit-state/types.js";
import { messageText, record } from "./event-normalizer.js";

export interface SessionSummary {
  tunnel?: Tunnel;
  key: string;
  id: string;
  name?: string;
  preview?: string;
  cwd: string;
  model?: string;
  updatedAt: number;
  messageCount: number;
  runtimeStatus: AgentStatus | "offline";
  owned: boolean;
  active: boolean;
  monitored?: boolean;
  live?: boolean;
}
export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  at?: number;
}
export interface SessionHistory {
  session: SessionSummary;
  messages: HistoryMessage[];
  truncated: boolean;
}
interface ParsedSession {
  header: Record<string, unknown> & { id: string; cwd: string };
  entries: Record<string, unknown>[];
  branch: Record<string, unknown>[];
  incomplete: boolean;
}
export class SessionError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}
export const canonicalPath = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
export const sessionKey = (path: string) =>
  createHash("sha256").update(canonicalPath(path)).digest("hex").slice(0, 32);
const expandHome = (path: string) => path.replace(/^~(?=[/\\]|$)/, homedir());
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_TEXT = 32_000;

export async function validateCwd(value: string): Promise<string> {
  if (!value.trim() || value.includes("\0") || !isAbsolute(value))
    throw new SessionError("cwd must be an absolute existing directory");
  try {
    const cwd = await realpath(value);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Not a directory");
    return cwd;
  } catch {
    throw new SessionError("cwd must be an absolute existing directory");
  }
}

// Mirrors Pi 0.87's persisted leaf: the last entry, then its parentId chain.
// Reading never opens SessionManager: opening an old file can migrate/write it.
export function parseSavedSession(content: string): ParsedSession {
  const values: Record<string, unknown>[] = [];
  let incomplete = false;
  for (const line of content.replace(/^\uFEFF/, "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = record(JSON.parse(line));
      if (!value) throw new Error("Invalid entry");
      values.push(value);
    } catch {
      incomplete = true; // A live append may leave its final line incomplete.
    }
  }
  const header = values[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" ||
      typeof header.cwd !== "string" || !isAbsolute(header.cwd) ||
      ![2, 3].includes(Number(header.version)))
    throw new SessionError("Only valid Pi session format v2/v3 is supported");
  const entries = values.slice(1);
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || byId.has(entry.id) ||
        (entry.parentId !== null && typeof entry.parentId !== "string"))
      throw new SessionError("Session has an invalid entry tree");
    byId.set(entry.id, entry);
  }
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let entry = entries.at(-1);
  while (entry) {
    const id = String(entry.id);
    if (seen.has(id)) throw new SessionError("Session has a cyclic entry tree");
    seen.add(id);
    branch.push(entry);
    if (entry.parentId === null) break;
    const parent = byId.get(String(entry.parentId));
    if (!parent) throw new SessionError("Session has a broken entry tree");
    entry = parent;
  }
  return { header: header as ParsedSession["header"], entries, branch: branch.reverse(), incomplete };
}

// Tools expose their names/outcomes, never raw payloads, thinking or hidden custom data.
export function historyMessages(messages: unknown[]): { messages: HistoryMessage[]; truncated: boolean } {
  let truncated = false;
  const result: HistoryMessage[] = [];
  for (const raw of messages) {
    const message = record(raw);
    if (!message) continue;
    const role = message.role === "toolResult" ? "tool" : message.role;
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    let text = role === "tool"
      ? `${typeof message.toolName === "string" ? message.toolName : "tool"}${message.isError ? " · failed" : " · completed"}`
      : messageText(message.content);
    if (!text) continue;
    if (text.length > MAX_TEXT) {
      text = "… [earlier text omitted]\n" + text.slice(-MAX_TEXT);
      truncated = true;
    }
    const timestamp = typeof message.timestamp === "number"
      ? message.timestamp : Date.parse(String(message.timestamp || ""));
    result.push({ role, text, ...(Number.isFinite(timestamp) ? { at: timestamp } : {}) });
  }
  return { messages: result.slice(-MAX_MESSAGES), truncated: truncated || result.length > MAX_MESSAGES };
}

function projectHistory(parsed: ParsedSession) {
  // This is a human transcript of the persisted branch, including pre-compaction
  // messages. It is deliberately not advertised as the exact model context.
  const edits = new Map<string, Record<string, unknown>>();
  for (const entry of parsed.branch)
    if (entry.type === "context_edit" && typeof entry.targetId === "string") edits.set(entry.targetId, entry);
  const messages = parsed.branch.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = record(entry.message);
    if (!message) return [];
    const edit = edits.get(String(entry.id));
    if (edit?.replacement === null) return [];
    const replacement = record(edit?.replacement);
    return [{ ...message, ...(replacement ? { content: replacement.content } : {}), timestamp: message.timestamp || entry.timestamp }];
  });
  return { ...historyMessages(messages), messageCount: messages.length };
}

export interface SessionRepositoryOptions {
  /** Root with Pi's per-cwd directories; injectable for fixture-only tests. */
  root?: string;
  /** Extra flat directories, e.g. a Pi --session-dir configuration. */
  directories?: string[];
}
export interface SessionCatalog {
  list(cwd?: string): Promise<{ sessions: SessionSummary[]; skipped: number }>;
  history(key: string): Promise<SessionHistory>;
  original(key: string): Promise<{ path: string; cwd: string; tunnel?: Tunnel; fresh?: boolean }>;
  create(cwd: string, name?: string, tunnel?: Tunnel): Promise<{ path: string; cwd: string; key: string }>;
  close?(): Promise<void>;
}
export class SessionRepository {
  readonly root: string;
  private directories: string[];
  private paths = new Map<string, string>();
  constructor(options: SessionRepositoryOptions = {}) {
    this.root = resolve(expandHome(options.root || join(
      expandHome(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")), "sessions")));
    this.directories = [...new Set([
      ...(!options.root && process.env.PI_CODING_AGENT_SESSION_DIR ? [expandHome(process.env.PI_CODING_AGENT_SESSION_DIR)] : []),
      ...(options.directories || []),
    ].map((path) => resolve(path)))];
  }
  private async read(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES)
      throw new SessionError("Session is not a regular file or exceeds the 32 MB read limit");
    const actual = canonicalPath(await realpath(path));
    const roots = await Promise.all([this.root, ...this.directories].map(async (root) => {
      try { return canonicalPath(await realpath(root)); } catch { return undefined; }
    }));
    if (!roots.some((root) => root && actual.startsWith(root + sep)))
      throw new SessionError("Session is outside configured session directories");
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      if (size > MAX_FILE_BYTES) throw new SessionError("Session exceeds the 32 MB read limit");
      // Snapshot only the bytes present at open: a concurrent append is never followed.
      const buffer = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const chunk = await file.read(buffer, read, size - read, read);
        if (!chunk.bytesRead) break;
        read += chunk.bytesRead;
      }
      return { parsed: parseSavedSession(buffer.subarray(0, read).toString("utf8")), updatedAt: info.mtimeMs };
    } finally { await file.close(); }
  }
  private summary(path: string, parsed: ParsedSession, updatedAt: number): SessionSummary {
    const metadata = parsed.entries.filter((entry) => entry.type === "session_info").at(-1);
    const model = parsed.branch.filter((entry) => entry.type === "model_change").at(-1);
    const history = projectHistory(parsed);
    return {
      key: sessionKey(path), id: parsed.header.id, cwd: parsed.header.cwd,
      name: typeof metadata?.name === "string" ? metadata.name : undefined,
      preview: history.messages.find(message => message.role === "user")?.text.replace(/\s+/g, " ").slice(0, 120),
      model: model && typeof model.modelId === "string" ? `${model.provider || ""}/${model.modelId}` : undefined,
      updatedAt, messageCount: history.messageCount,
      runtimeStatus: "offline", owned: false, active: false,
    };
  }
  async list(cwd?: string): Promise<{ sessions: SessionSummary[]; skipped: number }> {
    const candidates = new Set<string>();
    let skipped = 0;
    const scan = async (directory: string, descend: boolean) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") skipped++; return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && descend) await scan(path, false);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.add(path);
      }
    };
    await scan(this.root, true);
    for (const directory of this.directories) await scan(directory, false);
    const sessions: SessionSummary[] = [];
    const paths = new Map<string, string>();
    for (const path of candidates) {
      try {
        const { parsed, updatedAt } = await this.read(path);
        const summary = this.summary(path, parsed, updatedAt);
        paths.set(summary.key, path);
        if (!cwd || canonicalPath(summary.cwd) === canonicalPath(cwd)) sessions.push(summary);
      } catch { skipped++; }
    }
    this.paths = paths;
    return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), skipped };
  }
  private async lookup(key: string) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new SessionError("Unknown session key", 404);
    if (!this.paths.has(key)) await this.list();
    const path = this.paths.get(key);
    if (!path) throw new SessionError("Unknown session key; refresh the session list", 404);
    try { return { path, ...await this.read(path) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionError("Session no longer exists", 404);
      throw error;
    }
  }
  async history(key: string): Promise<SessionHistory> {
    const { path, parsed, updatedAt } = await this.lookup(key);
    const projected = projectHistory(parsed);
    return { session: this.summary(path, parsed, updatedAt), messages: projected.messages, truncated: projected.truncated || parsed.incomplete };
  }
  async original(key: string) {
    const { path, parsed } = await this.lookup(key);
    if (parsed.incomplete) throw new SessionError("Session has an incomplete write; wait and refresh before opening", 409);
    return { path, cwd: parsed.header.cwd };
  }
  async create(cwd: string, name?: string) {
    cwd = await validateCwd(cwd);
    const directory = join(this.root, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    await mkdir(directory, { recursive: true });
    if (!canonicalPath(await realpath(directory)).startsWith(canonicalPath(await realpath(this.root)) + sep)) throw new SessionError("Session directory is outside the configured root");
    const id = randomUUID(), timestamp = new Date().toISOString();
    const path = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    const entries: unknown[] = [{ type: "session", version: 3, id, timestamp, cwd }];
    if (name) entries.push({ type: "session_info", id: randomUUID(), parentId: null, timestamp, name });
    await writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
    this.paths.set(sessionKey(path), path);
    return { path, cwd, key: sessionKey(path) };
  }
}
