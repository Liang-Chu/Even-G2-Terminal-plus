import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tunnel } from "../cockpit-state/types.js";
import { SessionRepository, SessionError, canonicalPath, type SessionCatalog, type SessionHistory, type SessionSummary, type SessionRepositoryOptions } from "../pi-runtime/sessions.js";
import { readLocalJson, writeLocalJson } from "../pi-runtime/native-protocol.js";
import { connectorKey } from "./identity.js";
import { resolveAgent } from "./command.js";
import { stdioRpc, type AgentRpc } from "./rpc.js";
import { claudeQuestionText } from "./claude-questions.js";

export function codexHistory(thread: any): SessionHistory {
  const messages: SessionHistory["messages"] = [];
  for (const turn of thread.turns || []) for (const item of turn.items || []) {
    if (item.type === "userMessage") {
      const text = (item.content || []).filter((part: any) => part.type === "text").map((part: any) => part.text || "").join("\n");
      if (text) messages.push({ role: "user", text: text.slice(-32_000) });
    } else if (item.type === "agentMessage" && typeof item.text === "string") messages.push({ role: "assistant", text: item.text.slice(-32_000) });
    else if (item.type === "commandExecution") messages.push({ role: "tool", text: "Command" });
    else if (item.type === "fileChange") messages.push({ role: "tool", text: "File edit" });
  }
  const summary: SessionSummary = { key: connectorKey("codex", thread.id), id: thread.id, name: thread.name || undefined,
    preview: typeof thread.preview === "string" ? thread.preview.slice(0, 120) : undefined, cwd: thread.cwd || "",
    tunnel: "codex", model: thread.model, updatedAt: (thread.updatedAt || thread.createdAt || 0) * 1000,
    messageCount: messages.length, runtimeStatus: "offline", owned: false, active: false };
  return { session: summary, messages: messages.slice(-200), truncated: messages.length > 200 };
}

export async function readCodexHistory(rpc: Pick<AgentRpc, "request">, id: string): Promise<SessionHistory> {
  const metadata = (await rpc.request("thread/read", { threadId: id, includeTurns: false })).thread;
  try {
    const page = await rpc.request("thread/turns/list", { threadId: id, limit: 30, sortDirection: "desc", itemsView: "full" });
    const history = codexHistory({ ...metadata, turns: [...(page.data || [])].reverse() });
    history.truncated ||= !!page.nextCursor;
    return history;
  } catch {
    // Older non-paginated sessions support the original public history operation.
    return codexHistory((await rpc.request("thread/read", { threadId: id, includeTurns: true })).thread);
  }
}

export function claudeHistory(content: string, path: string, modified: number): SessionHistory | undefined {
  let id = "", cwd = "", name: string | undefined, model: string | undefined;
  const messages: SessionHistory["messages"] = [];
  let incomplete = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let row: any; try { row = JSON.parse(line); } catch { incomplete = true; continue; }
    if (row.isSidechain) continue;
    if (typeof row.sessionId === "string") id = row.sessionId;
    if (typeof row.cwd === "string") cwd = row.cwd;
    if (row.type === "custom-title" && typeof row.customTitle === "string") name = row.customTitle;
    const message = row.message;
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    if (typeof message.model === "string" && !message.model.startsWith("<")) model = message.model;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.flatMap((part: any) => part.type === "text" && typeof part.text === "string" ? [part.text]
        : message.role === "assistant" && part.type === "tool_use" && part.name === "AskUserQuestion"
          ? [claudeQuestionText(part.input) || ""].filter(Boolean) : []).join("\n") : "";
    if (text) messages.push({ role: message.role, text: text.slice(-32_000), at: Date.parse(row.timestamp) || 0 });
  }
  // Never include subagent files or silently guess a session ID from its path.
  if (!id || !cwd || !path.endsWith(id + ".jsonl")) return undefined;
  return { session: { key: connectorKey("claude", id), id, cwd, name, model, tunnel: "claude",
    preview: messages.find(m => m.role === "user")?.text.replace(/\s+/g, " ").slice(0, 120),
    updatedAt: modified, messageCount: messages.length, runtimeStatus: "offline", owned: false, active: false },
    messages: messages.slice(-200), truncated: incomplete || messages.length > 200 };
}

interface Options {
  data: string; pi?: SessionRepositoryOptions; claudeRoot?: string;
  codex?: () => Promise<Pick<AgentRpc, "request" | "close">>;
}
/** Native histories are read only; creation is delegated to each tool's own API/CLI. */
export class ConnectorCatalog implements SessionCatalog {
  private pi: SessionRepository;
  private references = new Map<string, { tunnel: "codex" | "claude"; id: string; cwd: string; path?: string }>();
  private cache = new Map<string, { modified: number; size: number; history: SessionHistory }>();
  private pending = new Map<string, SessionSummary>();
  private rpc?: AgentRpc;
  private connecting?: Promise<Pick<AgentRpc, "request" | "close">>;
  private lastFailure = 0;
  private closed = false;
  private pendingPath: string;
  constructor(private options: Options) {
    this.pi = new SessionRepository(options.pi);
    this.pendingPath = join(options.data, "connector-sessions.json");
    if (existsSync(this.pendingPath)) {
      const data = readLocalJson(this.pendingPath);
      if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error("Invalid connector session index");
      for (const row of data.sessions) if (["codex", "claude"].includes(row.tunnel) && typeof row.id === "string"
        && row.key === connectorKey(row.tunnel, row.id) && typeof row.cwd === "string") this.pending.set(row.key, row);
    }
  }
  private async codex() {
    if (this.closed) throw new Error("Session discovery stopped");
    if (this.options.codex) return this.options.codex();
    if (this.rpc && !this.rpc.closed) return this.rpc;
    if (this.connecting) return this.connecting;
    if (Date.now() - this.lastFailure < 30_000) throw new Error("Codex discovery unavailable");
    this.connecting = (async () => {
      try {
        const { rpc } = stdioRpc(resolveAgent("codex"), ["app-server", "--stdio"]);
        this.rpc = rpc;
        await rpc.initialize();
        if (this.closed) throw new Error("Session discovery stopped");
        return rpc;
      } catch (error) { this.rpc?.close(); this.lastFailure = Date.now(); throw error; }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async claudeList() {
    const root = resolve(this.options.claudeRoot || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"));
    const rows: SessionHistory[] = [];
    let projects; try { projects = await readdir(root, { withFileTypes: true }); } catch { return rows; }
    const actualRoot = canonicalPath(await realpath(root));
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const directory = join(root, project.name);
      let files; try { files = await readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".jsonl")) continue;
        const path = join(directory, file.name);
        try {
          const info = await lstat(path);
          if (info.size > 32 * 1024 * 1024 || !canonicalPath(await realpath(path)).startsWith(actualRoot + sep)) continue;
          const cached = this.cache.get(path);
          let history = cached?.modified === info.mtimeMs && cached.size === info.size ? cached.history : undefined;
          if (!history) history = claudeHistory(await readFile(path, "utf8"), path, info.mtimeMs);
          if (!history) continue;
          this.cache.set(path, { modified: info.mtimeMs, size: info.size, history });
          this.references.set(history.session.key, { tunnel: "claude", id: history.session.id, cwd: history.session.cwd, path });
          rows.push(history);
        } catch { /* A concurrently removed/locked native file is retried on the next scan. */ }
      }
    }
    const retained = new Set(rows.map(row => this.references.get(row.session.key)?.path));
    for (const path of this.cache.keys()) if (!retained.has(path)) this.cache.delete(path);
    return rows;
  }
  async list(cwd?: string) {
    const pi = await this.pi.list(cwd);
    const rows = new Map<string, SessionSummary>(pi.sessions.map(row => [row.key, { ...row, tunnel: "pi" as Tunnel }]));
    for (const row of this.pending.values()) {
      if (row.tunnel === "codex" || row.tunnel === "claude") this.references.set(row.key, { tunnel: row.tunnel, id: row.id, cwd: row.cwd });
      rows.set(row.key, row);
    }
    for (const history of await this.claudeList()) {
      rows.set(history.session.key, { ...history.session, name: history.session.name || this.pending.get(history.session.key)?.name });
    }
    try {
      const rpc = await this.codex();
      let cursor: string | undefined;
      // Bound a discovery pass; sort newest first, so the 24-hour default remains useful.
      for (let page = 0; page < 20; page++) {
        const result = await rpc.request("thread/list", { limit: 100, sortKey: "updated_at", cursor, archived: false, sourceKinds: ["cli", "vscode", "appServer"] });
        for (const thread of result.data || []) {
          if (typeof thread.id !== "string" || typeof thread.cwd !== "string") continue;
          const row = codexHistory(thread).session;
          this.references.set(row.key, { tunnel: "codex", id: row.id, cwd: row.cwd }); rows.set(row.key, row);
        }
        cursor = result.nextCursor; if (!cursor) break;
      }
    } catch { pi.skipped++; }
    return { sessions: [...rows.values()].filter(row => !cwd || canonicalPath(row.cwd) === canonicalPath(cwd))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)), skipped: pi.skipped };
  }
  private async reference(key: string) { if (!this.references.has(key)) await this.list(); return this.references.get(key); }
  async history(key: string): Promise<SessionHistory> {
    const reference = await this.reference(key);
    if (!reference) return this.pi.history(key);
    if (reference.tunnel === "codex") return readCodexHistory(await this.codex(), reference.id);
    const history = (await this.claudeList()).find(row => row.session.key === key);
    if (history) return history;
    const session = this.pending.get(key);
    if (session && !reference.path) return { session, messages: [], truncated: false };
    throw new SessionError("Session no longer exists", 404);
  }
  async original(key: string) {
    const reference = await this.reference(key);
    if (reference?.tunnel === "claude" && reference.path
      && !(await this.claudeList()).some(row => row.session.key === key)) throw new SessionError("Session no longer exists", 404);
    return reference ? { path: reference.id, cwd: reference.cwd, tunnel: reference.tunnel, fresh: reference.tunnel === "claude" && !reference.path }
      : { ...await this.pi.original(key), tunnel: "pi" as const };
  }
  async create(cwd: string, name?: string, tunnel: Tunnel = "pi") {
    if (tunnel === "pi") return this.pi.create(cwd, name);
    if (tunnel === "codex") throw new SessionError("Create Codex sessions in the native terminal");
    const id = randomUUID();
    const key = connectorKey(tunnel, id);
    this.pending.set(key, { key, id, name, cwd, tunnel, updatedAt: Date.now(), messageCount: 0, runtimeStatus: "offline", owned: false, active: false });
    this.references.set(key, { tunnel, id, cwd });
    writeLocalJson(this.pendingPath, { version: 1, sessions: [...this.pending.values()] });
    return { path: id, cwd, key };
  }
  async close() { this.closed = true; this.rpc?.close(); }
}
