import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { CockpitStore } from "../cockpit-state/store.js";
import type { RuntimeState } from "../cockpit-state/types.js";
import { promptLabel } from "../cockpit-state/selectors.js";
import { connectorKey } from "./identity.js";
import { canonicalPath } from "../pi-runtime/sessions.js";

type Outcome = "completed" | "interrupted";
export interface CodexObservation {
  state: RuntimeState;
  updatedAt: number;
  activity: boolean;
  retired?: boolean;
  completion?: { turnId: string; outcome: Outcome };
}
interface Rollout {
  path: string; offset: number; partial: Buffer; dropping: boolean; initialized: boolean;
  store: CockpitStore; id?: string; parent?: string; turn?: string; busy: boolean;
  updatedAt: number; available: boolean; changed: boolean; activity: boolean;
  pending: { turnId: string; outcome: Outcome; at: number }[];
  completed: Set<string>; announced: boolean; children: number;
  modifiedAt: number;
}
const CHUNK = 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Read-only adapter for local Codex rollout v0.159. Never resumes a thread or executes a hook.
 * Only explicit lifecycle records settle work; silence, file loss and malformed rows never do.
 * Rollouts are an internal format: unknown records are ignored, not guessed as completion.
 */
export class CodexObserver {
  private files = new Map<string, Rollout>();
  private started: number;
  private timer?: NodeJS.Timeout;
  private pendingPoll?: Promise<void>;
  private nextDiscovery = 0;
  private stopped = false;
  private names = new Map<string, string>();
  private indexModified = 0;
  readonly root: string;
  constructor(private receive: (observation: CodexObservation) => void,
    options: { root?: string; now?: number } = {}) {
    this.root = resolve(options.root || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"));
    this.started = options.now ?? Date.now();
  }
  async start() {
    await this.poll(true);
    this.timer = setInterval(() => { void this.poll().catch(() => {}); }, 750);
    this.timer.unref();
  }
  poll(discover = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pendingPoll) return this.pendingPoll;
    return this.pendingPoll = this.scan(discover).finally(() => { this.pendingPoll = undefined; });
  }
  private async discover() {
    // Codex's year/month/day tree is shallow. Never follow symlinks/junctions outside it.
    const actual = canonicalPath(await realpath(this.root));
    const walk = async (directory: string, depth: number): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) await walk(path, depth + 1);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) && !this.files.has(path)) {
          const info = await lstat(path);
          if (info.mtimeMs < Date.now() - 86_400_000 || !canonicalPath(await realpath(path)).startsWith(actual + sep)) continue;
          this.files.set(path, { path, offset: 0, partial: Buffer.alloc(0), dropping: false, initialized: false,
            store: new CockpitStore(""), busy: false, updatedAt: 0, available: true, changed: false,
            activity: false, pending: [], completed: new Set(), announced: false, children: 0, modifiedAt: info.mtimeMs });
        }
      }
    };
    await walk(this.root, 0);
    const index = join(dirname(this.root), "session_index.jsonl");
    try {
      const stat = await lstat(index);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs !== this.indexModified) {
        const handle = await open(index, "r");
        try {
          const buffer = Buffer.alloc(Math.min(stat.size, CHUNK * 2));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, stat.size - buffer.length);
          const names = new Map<string, string>();
          for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
            let value: any; try { value = JSON.parse(line); } catch { continue; }
            if (typeof value?.id === "string" && uuid.test(value.id) && typeof value.thread_name === "string") names.set(value.id, value.thread_name.slice(0, 128));
          }
          this.names = names;
          this.indexModified = stat.mtimeMs;
        } finally { await handle.close(); }
      }
    } catch { /* Titles are optional; runtime observation does not depend on the index. */ }
  }
  private async scan(discover: boolean) {
    if (discover || Date.now() >= this.nextDiscovery) {
      this.nextDiscovery = Date.now() + 3000;
      try { await this.discover(); } catch { /* Missing/locked directory is retried, never treated as a finish. */ }
    }
    const readFiles = new Set<string>();
    for (const file of this.files.values()) {
      try { await this.read(file); }
      catch { if (file.available) { file.available = false; file.changed = true; } }
      readFiles.add(file.path);
    }
    // A child can be created between scheduled discoveries. Its start must be
    // observed before a parent's completion is allowed to report zero agents.
    if ([...this.files.values()].some(file => !file.parent && file.pending.length)) {
      try { await this.discover(); } catch { return; }
      for (const file of this.files.values()) if (!readFiles.has(file.path)) {
        try { await this.read(file); }
        catch { file.available = false; file.changed = true; }
      }
      // Do not guess that an unreadable, newly discovered log is unrelated to a parent.
      if ([...this.files.values()].some(file => !file.available && !file.id)) return;
    }
    if (this.stopped) return;
    const byId = new Map([...this.files.values()].filter(f => f.id).map(f => [f.id!, f]));
    const childCounts = new Map<string, number>();
    for (const child of byId.values()) if (child.busy) {
      let parent = child.parent; const visited = new Set<string>();
      while (parent && !visited.has(parent)) {
        visited.add(parent); childCounts.set(parent, (childCounts.get(parent) || 0) + 1);
        parent = byId.get(parent)?.parent;
      }
    }
    for (const file of byId.values()) {
      if (!file.busy && !file.pending.length && !childCounts.get(file.id!) && file.modifiedAt < Date.now() - 86_400_000) {
        this.files.delete(file.path);
        if (!file.parent && file.announced) this.receive({ state: file.store.state, updatedAt: file.updatedAt, activity: false, retired: true });
        continue;
      }
      if (file.parent) continue;
      const children = childCounts.get(file.id!) || 0;
      const name = this.names.get(file.id!);
      if (name && name !== file.store.state.session.name) { file.store.state.session.name = name; file.changed = true; }
      const changed = file.changed || children !== file.children;
      file.children = children;
      if (!changed) continue;
      file.changed = false;
      // Initial history is a baseline. Do not turn every saved conversation into an open window.
      if (!file.announced && !file.activity && !file.busy && !file.pending.length) continue;
      file.announced = true;
      const state = file.store.state;
      const status = file.busy || children ? "running" : "idle";
      if (children) file.pending = file.pending.slice(-1);
      const completions = !file.busy && !children && file.available ? file.pending : [];
      const completion = completions.at(-1);
      file.store.publish({ ...state, connected: file.available,
        main: { ...state.main, status, ...(completion ? { settledAt: completion.at, statusSince: completion.at, outcome: completion.outcome } : {}) },
        subagents: { active: children, mainDelegated: !file.busy }, capabilities: { prompt: false, interrupt: false },
      }, { type: "monitoring.updated" });
      for (const [index, done] of (completions.length ? completions : [undefined]).entries()) {
        this.receive({ state: file.store.state, updatedAt: file.updatedAt, activity: index === 0 && file.activity,
          completion: done ? { turnId: done.turnId, outcome: done.outcome } : undefined });
      }
      file.activity = false;
      if (completions.length) file.pending = [];
    }
  }
  private async read(file: Rollout) {
    const info = await lstat(file.path);
    file.modifiedAt = info.mtimeMs;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Rollout is no longer a regular file");
    if (!canonicalPath(await realpath(file.path)).startsWith(canonicalPath(await realpath(this.root)) + sep)) throw new Error("Rollout moved outside root");
    if (!file.available) { file.available = true; file.changed = true; }
    if (info.size < file.offset) {
      // A truncated/replaced log cannot safely continue the previous run.
      file.offset = 0; file.partial = Buffer.alloc(0); file.dropping = false; file.initialized = false;
      file.turn = undefined; file.pending = [];
      // Preserve the last known busy state until another explicit lifecycle record.
      // Truncation is not an idle transition and cannot authorize an exit/push.
    }
    if (info.size === file.offset) return;
    const handle = await open(file.path, "r");
    try {
      // On first discovery read metadata plus a bounded recent tail, then only appended bytes.
      if (!file.initialized && info.size > CHUNK * 2) {
        const head = Buffer.alloc(CHUNK);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        const newline = head.indexOf(10);
        if (newline >= 0 && newline < bytesRead) this.line(file, head.subarray(0, newline));
        file.offset = info.size - CHUNK * 2;
        await this.seedLifecycle(file, handle, file.offset);
        file.partial = Buffer.alloc(0); file.dropping = true;
      }
      // Bound work per tick and keep partial UTF-8 in bytes, never split a decoded character.
      for (let n = 0; n < 4 && file.offset < info.size; n++) {
        const buffer = Buffer.alloc(Math.min(CHUNK, info.size - file.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, file.offset);
        if (!bytesRead) break;
        file.offset += bytesRead;
        const data = Buffer.concat([file.partial, buffer.subarray(0, bytesRead)]);
        let start = 0, end: number;
        while ((end = data.indexOf(10, start)) >= 0) {
          if (!file.dropping && end - start <= CHUNK) this.line(file, data.subarray(start, end));
          file.dropping = false; start = end + 1;
        }
        file.partial = Buffer.from(data.subarray(start));
        if (file.partial.length > CHUNK) { file.partial = Buffer.alloc(0); file.dropping = true; }
      }
      file.initialized = true;
    } finally { await handle.close(); }
  }
  private async seedLifecycle(file: Rollout, handle: FileHandle, end: number) {
    // A long-running turn may have megabytes of tool output after task_started.
    // Find its last lifecycle record without retaining that output or exposing reasoning.
    let suffix = Buffer.alloc(0), cursor = end, foundModel = false, foundLifecycle = false;
    while (!this.stopped && cursor > 0 && (!foundLifecycle || !foundModel)) {
      const size = Math.min(CHUNK, cursor); cursor -= size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, cursor);
      const data = Buffer.concat([buffer.subarray(0, bytesRead), suffix]);
      const first = cursor ? data.indexOf(10) : -1;
      const lines = data.subarray(first + 1).toString("utf8").split("\n");
      // The rightmost line in the first chunk is incomplete at the tail boundary.
      if (end === cursor + size) lines.pop();
      for (let n = lines.length - 1; n >= 0; n--) {
        const line = lines[n];
        if (line.length > CHUNK || (!line.includes('"turn_context"') && !line.includes('"event_msg"'))) continue;
        let row: any; try { row = JSON.parse(line); } catch { continue; }
        if (!foundModel && row?.type === "turn_context" && typeof row.payload?.model === "string") {
          this.line(file, Buffer.from(line)); foundModel = true;
        } else if (!foundLifecycle && row?.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(row.payload?.type)) {
          this.line(file, Buffer.from(line)); foundLifecycle = true;
        }
      }
      suffix = first >= 0 && first <= CHUNK ? Buffer.from(data.subarray(0, first)) : Buffer.alloc(0);
    }
  }
  private line(file: Rollout, bytes: Buffer) {
    let row: any; try { row = JSON.parse(bytes.toString("utf8")); } catch { return; }
    const p = row?.payload;
    if (!p || typeof p !== "object") return;
    if (row.type === "session_meta") {
      // Desktop subagent/fork rollouts contain copied parent history, including
      // its session_meta. The first valid record owns this file; accepting a
      // later copied record would turn a child into the parent and replay its
      // completions while the real parent is still working.
      if (file.id) return;
      if (typeof p.id !== "string" || !uuid.test(p.id) || typeof p.cwd !== "string") return;
      const parent = p.parent_thread_id || p.source?.subagent?.thread_spawn?.parent_thread_id;
      if (!parent && !["cli", "vscode", "appServer"].includes(p.source)) return;
      file.id = p.id; file.parent = typeof parent === "string" ? parent : undefined;
      file.store.state.session = { id: p.id, key: connectorKey("codex", p.id), tunnel: "codex", cwd: p.cwd };
      return;
    }
    if (!file.id) return;
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at) || at > Date.now() + 60_000) return;
    const live = at >= this.started;
    file.updatedAt = Math.max(file.updatedAt, at);
    if (row.type === "turn_context" && typeof p.model === "string") {
      file.store.state.session.model = p.model.slice(0, 128); file.changed = true;
    } else if (row.type === "event_msg" && p.type === "task_started" && typeof p.turn_id === "string") {
      if (file.completed.has(p.turn_id) || file.turn === p.turn_id) return;
      file.turn = p.turn_id; file.busy = true; file.activity ||= live; file.changed = true;
      file.store.state.main = { status: "running", startedAt: at, statusSince: at };
    } else if (row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p.type) && typeof p.turn_id === "string") {
      if (file.completed.has(p.turn_id) || (file.turn && file.turn !== p.turn_id)) return;
      file.completed.add(p.turn_id);
      if (file.completed.size > 256) file.completed.delete(file.completed.values().next().value!);
      file.busy = false; file.changed = true;
      if (live) {
        file.pending.push({ turnId: p.turn_id, outcome: p.type === "turn_aborted" ? "interrupted" : "completed", at });
        file.pending = file.pending.slice(-32);
      }
      file.store.state.main = { ...file.store.state.main, status: "idle", settledAt: at, statusSince: at };
      file.store.state.tools = { active: {} };
    } else if (!file.parent && row.type === "response_item" && p.type === "message" && ["user", "assistant"].includes(p.role)
      && (p.role === "user" || [undefined, "final", "commentary"].includes(p.channel)) && Array.isArray(p.content)) {
      const text = p.content.filter((part: any) => ["input_text", "output_text"].includes(part?.type) && typeof part.text === "string")
        .map((part: any) => part.text).join("\n").slice(-20_000);
      if (!text) return;
      file.store.dispatch(p.role === "user" ? { type: "user.message", text } : { type: "assistant.completed", text });
      file.store.state.transcript = file.store.state.transcript.slice(-40);
      let budget = 60_000;
      file.store.state.transcript = file.store.state.transcript.reverse().filter(entry => { budget -= entry.text.length; return budget >= 0; }).reverse();
      if (p.role === "user") file.store.state.session.name ||= promptLabel(text);
      file.changed = true;
    }
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.pendingPoll; }
}
