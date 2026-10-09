import { constants, lstatSync, readFileSync } from "node:fs";
import { lstat, open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { CockpitStore } from "../cockpit-state/store.js";
import type { InputAttention, RuntimeState } from "../cockpit-state/types.js";
import { promptLabel } from "../cockpit-state/selectors.js";
import { connectorKey } from "./identity.js";
import { claudeHistory } from "./catalog.js";
import { readClaudeTranscript } from "./claude-transcript.js";
import { canonicalPath } from "../pi-runtime/sessions.js";
import { writeLocalJson, uuidPattern } from "../pi-runtime/native-protocol.js";
import { claudeProcessIdentity } from "../../apps/windows/src/connectors/claude-interrupt.js";

type Outcome = "completed" | "failed";
export interface ClaudeOwner { pid: number; started: string }
export interface ClaudeObservation {
  state: RuntimeState; updatedAt: number; activity: boolean; retired?: boolean;
  completion?: { turnId: string; outcome: Outcome };
}
interface SavedSession {
  id: string; path: string; cwd: string; owner: ClaudeOwner; model?: string; name?: string;
  turn?: string; turnAt?: number; mainBusy: boolean; pendingDone: boolean; outcome: Outcome;
  children: string[]; background: string[]; crons?: string[]; unknownChildren?: boolean; waiting?: boolean; warning?: string;
  childEvents?: { id: string; at: number; startAt?: number; stopTrusted?: boolean; ambiguous?: boolean }[];
  attention?: (InputAttention & { toolId?: string })[];
  ended: boolean; lastAt: number; updatedAt: number;
}
interface Session extends SavedSession { store: CockpitStore; online: boolean; historyLoaded: boolean }
const names = new Set(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
  "SessionEnd", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]);
const ownerValid = (value: any): value is ClaudeOwner => value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.started === "string" && /^\d{1,20}$/.test(value.started);
const sameOwner = (a: ClaudeOwner, b: ClaudeOwner) => a.pid === b.pid && a.started === b.started;
const terminalTask = new Set(["completed", "failed", "cancelled", "canceled", "done", "stopped"]);
const ambiguousChildWarning = "Claude child lifecycle order is ambiguous; completion is unconfirmed.";
class InvalidQueuedEvent extends Error {}
interface UnreadableEvent { at: number; sessionId?: string; owner?: ClaudeOwner }

/** Ordinary Claude terminals emit official hooks into a private queue. This
 * adapter never controls the CLI and never guesses completion from silence,
 * transcript text, process loss or SessionEnd. */
export class ClaudeObserver {
  private historyStats = new Map<string, { modified: number; size: number }>();
  readonly directory: string;
  readonly root: string;
  private statePath: string;
  private sessions = new Map<string, Session>();
  private processed = new Set<string>();
  private pending: ClaudeObservation[] = [];
  private dirty = false;
  private started: number;
  private timer?: NodeJS.Timeout;
  private task?: Promise<void>;
  private stopped = false;
  private ownerCache = new Map<string, { at: number; alive: boolean }>();
  private queueCursor = "";
  private unreadable = new Map<string, UnreadableEvent>();
  private missingEvents: number[] = [];
  private missingThrough = 0;
  private gapUnconfirmed = false;
  constructor(private receive: (observation: ClaudeObservation) => void, private options: {
    directory: string; root?: string; now?: () => number;
    alive?: (owner: ClaudeOwner) => Promise<boolean>;
  }) {
    this.directory = resolve(options.directory);
    this.root = resolve(options.root || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"));
    this.statePath = join(this.directory, "../claude-monitor-state.json");
    this.started = this.now();
    try {
      const info = lstatSync(this.statePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error();
      const saved = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > 64 ||
          !Array.isArray(saved.processed) || saved.processed.length > 2048) throw new Error();
      if (saved.missingEvents !== undefined && (!Array.isArray(saved.missingEvents) || saved.missingEvents.length > 256 ||
          saved.missingEvents.some((at: unknown) => !Number.isFinite(at)))) throw new Error();
      this.missingEvents = saved.missingEvents || [];
      this.missingThrough = Number.isFinite(saved.missingThrough) ? Math.max(0, saved.missingThrough) : 0;
      this.gapUnconfirmed = saved.gapUnconfirmed === true;
      for (const id of saved.processed) if (typeof id === "string" && uuidPattern.test(id)) this.processed.add(id);
      for (const row of saved.sessions) {
        if (!uuidPattern.test(row.id) || !ownerValid(row.owner) || typeof row.path !== "string" || row.path.length > 4096 || !row.path.endsWith(row.id + ".jsonl") ||
            typeof row.cwd !== "string" || row.cwd.length > 4096 || !Array.isArray(row.children) || row.children.length > 256 ||
            !Array.isArray(row.background) || row.background.length > 256 ||
            (row.crons !== undefined && (!Array.isArray(row.crons) || row.crons.length > 256 || row.crons.some((value: unknown) => typeof value !== "string" || value.length > 128))) ||
            [...row.children, ...row.background].some(value => typeof value !== "string" || value.length > 128) ||
            (row.attention !== undefined && (!Array.isArray(row.attention) || row.attention.length > 16 || row.attention.some((value: any) =>
              !value || typeof value.id !== "string" || value.id.length > 200 || !["approval", "question"].includes(value.kind) ||
              !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.createdAt > this.now() + 60_000 ||
              (value.toolId !== undefined && (typeof value.toolId !== "string" || value.toolId.length > 256))))) ||
            (row.childEvents !== undefined && (!Array.isArray(row.childEvents) || row.childEvents.length > 256 ||
              new Set(row.childEvents.map((event: any) => event?.id)).size !== row.childEvents.length || row.childEvents.some((event: any) =>
                !event || typeof event.id !== "string" || !event.id || event.id.length > 128 || !Number.isFinite(event.at) || event.at < 0 ||
                (event.startAt !== undefined && (!Number.isFinite(event.startAt) || event.startAt < 0 || event.startAt > event.at)) ||
                (event.stopTrusted !== undefined && typeof event.stopTrusted !== "boolean") ||
                (event.ambiguous !== undefined && typeof event.ambiguous !== "boolean")))) ||
            typeof row.mainBusy !== "boolean" || typeof row.pendingDone !== "boolean" || typeof row.ended !== "boolean" ||
            !["completed", "failed"].includes(row.outcome) || !Number.isFinite(row.lastAt) || !Number.isFinite(row.updatedAt)) throw new Error();
        const store = new CockpitStore(row.cwd);
        store.dispatch({ type: "session.updated", session: { key: connectorKey("claude", row.id), id: row.id,
          tunnel: "claude", cwd: row.cwd, model: row.model, name: row.name } });
        this.sessions.set(row.id, { ...row, attention: row.attention?.map((request: any) => ({ id: request.id, kind: request.kind,
          createdAt: request.createdAt, toolId: request.toolId, baseline: true })),
          store, online: false, historyLoaded: false });
      }
    } catch { /* An unreadable baseline never fabricates completed work. */ }
  }
  private now() { return (this.options.now || Date.now)(); }
  async start() {
    await this.poll();
    this.timer = setInterval(() => { void this.poll().catch(() => {}); }, 1000);
    this.timer.unref();
  }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.task) return this.task;
    return this.task = this.scan().finally(() => { this.task = undefined; });
  }
  private async alive(owner: ClaudeOwner) {
    if (this.options.alive) return this.options.alive(owner);
    const key = owner.pid + ":" + owner.started, cached = this.ownerCache.get(key);
    // Windows identity probes launch a tiny hidden native helper. Never repeat
    // that per queued tool event or per session with the same owner.
    if (cached && Date.now() - cached.at < (process.platform === "win32" ? 5000 : 1000)) return cached.alive;
    let alive = false;
    try { alive = await claudeProcessIdentity(owner.pid) === owner.started; } catch {}
    if (this.ownerCache.size > 128) this.ownerCache.clear();
    this.ownerCache.set(key, { at: Date.now(), alive }); return alive;
  }
  private save() {
    const sessions = [...this.sessions.values()].map(({ store: _, online: __, historyLoaded: ___, ...row }) => row);
    writeLocalJson(this.statePath, { version: 1, sessions, processed: [...this.processed].slice(-2048),
      missingEvents: this.missingEvents, missingThrough: this.missingThrough, gapUnconfirmed: this.gapUnconfirmed });
    this.dirty = false;
  }
  private async input(path: string) {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 100_000) throw new InvalidQueuedEvent();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const current = await file.stat();
      if (!current.isFile() || current.size > 100_000 || current.ino !== before.ino || current.dev !== before.dev) throw new Error();
      const bytes = Buffer.alloc(current.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) throw new Error();
      try { return JSON.parse(bytes.toString("utf8")); } catch { throw new InvalidQueuedEvent(); }
    } finally { await file.close(); }
  }
  private async validPath(path: string, id: string, retryMissing = false) {
    if (!path.endsWith(id + ".jsonl")) return false;
    try {
      const info = await lstat(path);
      return info.isFile() && !info.isSymbolicLink() &&
        canonicalPath(await realpath(path)).startsWith(canonicalPath(await realpath(this.root)) + sep);
    } catch (error: any) {
      // UserPromptSubmit can run before Claude commits its first transcript
      // entry. Keep the queue record until the expected file exists.
      if (error.code === "ENOENT" && canonicalPath(resolve(path)).startsWith(canonicalPath(this.root) + sep)) {
        if (retryMissing) throw error;
        return undefined;
      }
      return false;
    }
  }
  private async history(session: Session) {
    try {
      if (!await this.validPath(session.path, session.id)) return;
      const info = await lstat(session.path), cached = this.historyStats.get(session.id);
      if (session.historyLoaded && cached?.modified === info.mtimeMs && cached.size === info.size) return;
      const recent = await readClaudeTranscript(session.path, this.root);
      const data = claudeHistory(recent.content, session.path, recent.modified, recent.metadata);
      if (!data) return;
      this.historyStats.set(session.id, { modified: recent.modified, size: recent.size }); session.historyLoaded = true;
      session.name ||= data.session.name || promptLabel(data.messages.find(row => row.role === "user")?.text || "") || undefined;
      session.model ||= data.session.model;
      let budget = 60_000;
      // Hooks can arrive before their text is committed to the transcript.
      // Keep that recent display tail; history never controls completion state.
      const latestAt = Math.max(0, ...data.messages.map(row => row.at || 0));
      const tail = session.store.state.transcript.filter(row => (row.at || 0) > latestAt
        && !data.messages.some(saved => saved.role === row.role && saved.text === row.text));
      const transcript = [...data.messages, ...tail].slice(-40).reverse().flatMap((row, index) => {
        if (!budget) return [];
        const text = row.text.slice(-Math.min(budget, 12_000)); budget -= text.length;
        return [{ id: index + 1, role: row.role, text, at: row.at || 0 }];
      }).reverse();
      session.store.dispatch({ type: "session.history", transcript });
      this.dirty = true;
      return true;
    } catch { /* History is display data, not a lifecycle authority. */ }
  }
  private background(session: Session, value: unknown) {
    if (value === undefined) return;
    if (!Array.isArray(value)) { session.background = ["unknown-registry"]; return; }
    // An authoritative empty list clears blockers. Missing metadata preserves
    // known pending work; malformed/unknown in-flight entries fail closed.
    session.background = value.slice(0, 255).flatMap((task, index) => {
      if (task && typeof task === "object" && terminalTask.has(String(task.status || ""))) return [];
      return [task && typeof task.id === "string" && task.id.length <= 128 ? task.id : "unknown-" + index];
    });
    if (value.length > 255) session.background.push("unknown-overflow");
  }
  private crons(session: Session, value: unknown) {
    if (value === undefined) return;
    if (!Array.isArray(value)) { session.crons = ["unknown-cron-registry"]; return; }
    session.crons = value.slice(0, 255).map((entry, index) => entry && typeof entry.id === "string" && entry.id.length <= 128
      ? entry.id : "unknown-cron-" + index);
    if (value.length > 255) session.crons.push("unknown-cron-overflow");
  }
  private announce(session: Session, activity = false, completion?: ClaudeObservation["completion"]) {
    const running = session.mainBusy || session.children.length > 0 || session.background.length > 0 || session.crons?.length || session.unknownChildren;
    const state = session.store.state;
    session.store.publish({ ...state, connected: session.online && !session.ended,
      session: { ...state.session, name: session.name, model: session.model, cwd: session.cwd },
      main: { ...state.main, status: session.attention?.length ? "waiting" : running ? session.waiting ? "waiting" : "running" : completion?.outcome === "failed" ? "failed" : "idle",
        startedAt: session.turnAt, ...(completion ? { settledAt: this.now(), statusSince: this.now(), outcome: completion.outcome } : {}) },
      subagents: { active: session.children.filter(id => !session.childEvents?.some(event => event.id === id && event.stopTrusted === true)).length,
        mainDelegated: !session.mainBusy && session.children.length > 0,
        uncertain: session.unknownChildren || Boolean(session.warning) || session.children.some(id => {
          const event = session.childEvents?.find(event => event.id === id);
          return event?.startAt === undefined || event.stopTrusted !== undefined;
        }) || undefined },
      capabilities: { prompt: false, interrupt: false },
      commandStatus: session.warning,
      attention: session.attention?.map(({ toolId: _, ...request }) => request),
    }, { type: "monitoring.updated" });
    this.pending.push({ state: session.store.state, updatedAt: session.updatedAt, activity, completion });
  }
  private settle(session: Session, at: number): ClaudeObservation["completion"] {
    if (!session.pendingDone || session.mainBusy || session.children.length || session.background.length || session.crons?.length || session.unknownChildren || session.attention?.length || !session.turn) return;
    session.pendingDone = false;
    // Old queued Stop records establish a baseline, never replay notifications.
    return at >= this.started ? { turnId: session.turn, outcome: session.outcome } : undefined;
  }
  private guardGaps(session: Session, at: number) {
    if (session.pendingDone && (this.gapUnconfirmed || (session.turnAt || 0) <= this.missingThrough ||
        this.missingEvents.some(missing => missing >= (session.turnAt || 0) && missing <= at))) {
      session.unknownChildren = true;
      session.warning = "Claude monitor received invalid or missing event data; completion is unconfirmed.";
    }
  }
  private childEvent(session: Session, raw: any, late: boolean) {
    const id = raw.agent_id;
    if (typeof id !== "string" || !id || id.length > 128) {
      session.unknownChildren = true; session.warning = "Claude agent count is incomplete; completion is unconfirmed."; return;
    }
    const previous = session.childEvents?.find(event => event.id === id);
    if (previous && raw.at < previous.at) return;
    if (previous && raw.at === previous.at && (previous.ambiguous ||
        (raw.hook_event_name === "SubagentStart") === (previous.stopTrusted !== undefined))) {
      // Hooks use millisecond timestamps. Opposite lifecycle records tied at
      // the same time cannot prove whether a resumed child actually stopped.
      // Keep uncertainty local to this ID until newer authoritative evidence.
      if (!session.children.includes(id)) {
        if (session.children.length >= 256) { session.unknownChildren = true; return; }
        session.children.push(id);
      }
      session.childEvents = [...(session.childEvents || []).filter(event => event.id !== id),
        { ...previous, startAt: previous.startAt ?? (raw.hook_event_name === "SubagentStart" ? raw.at : undefined),
          stopTrusted: false, ambiguous: true }].slice(-256);
      session.warning = ambiguousChildWarning; return;
    }
    let event: NonNullable<SavedSession["childEvents"]>[number];
    if (raw.hook_event_name === "SubagentStart") {
      if (!session.children.includes(id)) {
        if (session.children.length >= 256) {
          session.unknownChildren = true; session.warning = "Claude agent count is incomplete; completion is unconfirmed."; return;
        }
        session.children.push(id);
      }
      event = { id, at: raw.at, startAt: raw.at };
    } else {
      event = { id, at: raw.at, startAt: previous?.startAt, stopTrusted: raw.stopTrusted === true };
      if (raw.stopTrusted !== true) session.warning = "Claude has additional or unverified stop hooks; completion is unconfirmed.";
      // Parent tool events can arrive before a slower child's Stop hook. Its
      // independent start watermark, not the parent's timestamp, owns its life.
      // A legacy child has no start evidence: an old acknowledgement can repair
      // display activity but must retain its conservative completion blocker.
      else if (previous?.startAt !== undefined || !late) session.children = session.children.filter(child => child !== id);
    }
    session.childEvents = [...(session.childEvents || []).filter(previous => previous.id !== id), event].slice(-256);
    if (session.warning === ambiguousChildWarning && !session.children.some(id => session.childEvents?.some(event => event.id === id && event.ambiguous)))
      session.warning = undefined;
  }
  private async definitivelyRetired(owner: ClaudeOwner) {
    if (this.options.alive) {
      try { return await this.options.alive(owner) === false; } catch { return false; }
    }
    try { process.kill(owner.pid, 0); }
    catch (error: any) { return error.code === "ESRCH"; }
    try {
      const identity = await claudeProcessIdentity(owner.pid);
      return typeof identity === "string" && /^\d{1,20}$/.test(identity) && identity !== owner.started;
    } catch { return false; }
  }
  private async event(raw: any) {
    if (raw?.version !== 1 || !uuidPattern.test(raw.eventId || "") || !uuidPattern.test(raw.session_id || "") ||
        !names.has(raw.hook_event_name) || !Number.isFinite(raw.at) || raw.at > this.now() + 60_000 ||
        typeof raw.cwd !== "string" || typeof raw.transcript_path !== "string" || !ownerValid(raw.owner)) return false;
    let validPath: boolean | undefined;
    try { validPath = await this.validPath(raw.transcript_path, raw.session_id, raw.hook_event_name === "UserPromptSubmit"); }
    catch (error: any) {
      if (error.code !== "ENOENT" || raw.hook_event_name !== "UserPromptSubmit" || !await this.definitivelyRetired(raw.owner)) throw error;
      // A retired owner cannot commit its first transcript. Drain its obsolete
      // prompt while retaining lifecycle uncertainty, never a completion.
      this.missingEvents = [...new Set([...this.missingEvents, raw.at])].sort((a, b) => a - b).slice(-256);
      if (Number.isFinite(raw.gapThrough)) this.missingThrough = Math.max(this.missingThrough, raw.gapThrough);
      if (raw.gapUnconfirmed === true) this.gapUnconfirmed = true;
      const session = this.sessions.get(raw.session_id);
      if (session && sameOwner(session.owner, raw.owner)) {
        session.unknownChildren = true; session.warning = "Claude monitor received invalid or missing event data; completion is unconfirmed.";
        this.announce(session);
      }
      this.dirty = true;
      return true;
    }
    if (validPath === false) return false;
    if (!["SubagentStart", "SubagentStop"].includes(raw.hook_event_name) && raw.agent_id) return true;
    let session = this.sessions.get(raw.session_id);
    if (Number.isFinite(raw.gapThrough)) this.missingThrough = Math.max(this.missingThrough, raw.gapThrough);
    if (raw.gapUnconfirmed === true) this.gapUnconfirmed = true;
    if (validPath === undefined && !["SessionStart", "SessionEnd"].includes(raw.hook_event_name)) {
      // A known session's missing transcript cannot starve every other CLI.
      // Lifecycle uncertainty remains attached to that owner instead.
      if (session && sameOwner(session.owner, raw.owner)) {
        session.unknownChildren = true; session.warning = "Claude monitor received invalid or missing event data; completion is unconfirmed.";
        this.announce(session);
      }
      return true;
    }
    if (session && raw.at < session.lastAt) {
      if (sameOwner(session.owner, raw.owner) && ["SubagentStart", "SubagentStop"].includes(raw.hook_event_name)) {
        this.childEvent(session, raw, true);
        this.guardGaps(session, session.lastAt);
        // Do not regress parent registries, model, turn or timestamp from a
        // late child. Legacy acknowledgements cannot settle retained blockers.
        this.announce(session, false, session.ended ? undefined : this.settle(session, session.lastAt));
      }
      return true;
    }
    if (session && !sameOwner(session.owner, raw.owner)) {
      if (raw.hook_event_name !== "UserPromptSubmit" && await this.alive(session.owner)) return true;
      session.mainBusy = false; session.pendingDone = false; session.children = []; session.background = [];
      session.childEvents = [];
      session.crons = [];
      session.unknownChildren = false; session.waiting = false; session.warning = undefined; session.attention = [];
      session.turn = undefined; session.turnAt = undefined; session.owner = raw.owner;
    }
    if (!session) {
      if (validPath === undefined) return true;
      if (this.sessions.size >= 64) {
        const disposable = [...this.sessions.values()].filter(row => row.ended || (!row.online && !row.pendingDone))
          .sort((a, b) => a.lastAt - b.lastAt)[0];
        if (!disposable) return false;
        this.sessions.delete(disposable.id);
        this.historyStats.delete(disposable.id);
        this.pending.push({ state: disposable.store.state, updatedAt: disposable.updatedAt, activity: false, retired: true });
      }
      const store = new CockpitStore(raw.cwd);
      store.dispatch({ type: "session.updated", session: { id: raw.session_id, key: connectorKey("claude", raw.session_id), tunnel: "claude", cwd: raw.cwd } });
      session = { id: raw.session_id, owner: raw.owner, path: raw.transcript_path, cwd: raw.cwd, store,
        mainBusy: false, pendingDone: false, outcome: "completed", children: [], childEvents: [], background: [], ended: false,
        lastAt: raw.at, updatedAt: raw.at, online: await this.alive(raw.owner), historyLoaded: false };
      this.sessions.set(session.id, session);
    }
    await this.history(session);
    session.lastAt = raw.at; session.updatedAt = raw.at; session.cwd = raw.cwd; session.path = raw.transcript_path;
    if (typeof raw.model === "string") session.model = raw.model.slice(0, 128);
    if (typeof raw.session_title === "string" && raw.session_title.trim()) session.name = raw.session_title.trim().slice(0, 180);
    const store = session.store;
    let activity = false;
    switch (raw.hook_event_name) {
      case "SessionStart": session.ended = false; break;
      case "UserPromptSubmit":
        session.ended = false; session.mainBusy = true; session.pendingDone = true; session.outcome = "completed";
        session.waiting = false; session.attention = [];
        session.turn = raw.eventId; session.turnAt = raw.at; activity = raw.at >= this.started;
        store.dispatch({ type: "agent.started" });
        if (typeof raw.prompt === "string" && raw.prompt.length <= 32_000) {
          store.dispatch({ type: "user.message", text: raw.prompt });
          session.name ||= promptLabel(raw.prompt) || undefined;
        }
        break;
      case "PreToolUse":
        // PreToolUse proves permission for this tool has been granted. A
        // different succeeding tool also proves a prior main dialog ended.
        session.attention = (session.attention || []).filter(request => request.kind !== "approval" && request.toolId === raw.tool_use_id);
        session.ended = false;
        if (!session.pendingDone && !session.mainBusy) {
          session.turn = raw.eventId; session.turnAt = raw.at; session.pendingDone = true;
          session.outcome = "completed"; activity = raw.at >= this.started;
          store.dispatch({ type: "agent.started" });
        }
        session.mainBusy = true; session.waiting = false;
        if (typeof raw.tool_use_id === "string") store.dispatch({ type: "tool.started", id: raw.tool_use_id, name: typeof raw.tool_name === "string" ? raw.tool_name.slice(0, 128) : "tool" });
        if (raw.tool_name === "AskUserQuestion") this.inputNeeded(session, raw, "question");
        break;
      case "PostToolUse": case "PostToolUseFailure":
        if (typeof raw.tool_use_id === "string") store.dispatch({ type: "tool.finished", id: raw.tool_use_id, failed: raw.hook_event_name === "PostToolUseFailure" });
        if (typeof raw.tool_use_id === "string") session.attention = (session.attention || []).filter(request => request.toolId !== raw.tool_use_id);
        session.waiting = !!session.attention?.length;
        break;
      case "PermissionRequest": session.waiting = true; this.inputNeeded(session, raw, "approval"); break;
      case "SubagentStart":
        this.childEvent(session, raw, false);
        break;
      case "SubagentStop":
        this.background(session, raw.background_tasks);
        this.crons(session, raw.session_crons);
        this.childEvent(session, raw, false);
        break;
      case "Stop": case "StopFailure":
        this.background(session, raw.background_tasks);
        this.crons(session, raw.session_crons);
        session.waiting = false;
        if (raw.hook_event_name === "StopFailure" || raw.stopTrusted === true) {
          session.attention = [];
          session.mainBusy = false;
          if (!session.unknownChildren) session.warning = undefined;
        }
        else session.warning = "Claude has additional or unverified stop hooks; completion is unconfirmed.";
        session.outcome = raw.hook_event_name === "StopFailure" ? "failed" : "completed";
        if (typeof raw.last_assistant_message === "string" && raw.last_assistant_message.length <= 32_000)
          store.dispatch({ type: "assistant.completed", text: raw.last_assistant_message });
        break;
      case "SessionEnd": session.ended = true; session.online = false; break;
    }
    this.guardGaps(session, raw.at);
    if (raw.hook_event_name === "Stop" && raw.stopTrusted === true && Array.isArray(raw.background_tasks) &&
        raw.background_tasks.length === 0 && !session.unknownChildren) {
      // Old versions persisted child IDs without start timestamps. Only a
      // later trusted parent stop with an explicitly empty in-flight registry
      // resolves those already acknowledged IDs. Running/restarted children
      // and untrusted child stops keep their independent completion guards.
      session.children = session.children.filter(id => {
        const event = session.childEvents?.find(event => event.id === id);
        if (event?.startAt === undefined && event?.stopTrusted === true && event.at <= raw.at) {
          event.at = raw.at; return false;
        }
        return true;
      });
    }
    const completion = session.ended ? undefined : this.settle(session, raw.at);
    this.announce(session, activity, completion);
    return true;
  }
  private inputNeeded(session: Session, raw: any, kind: "approval" | "question") {
    const toolId = typeof raw.tool_use_id === "string" && raw.tool_use_id.length <= 256 ? raw.tool_use_id : undefined;
    const id = createHash("sha256").update(`${session.owner.pid}:${session.owner.started}:${kind}:${toolId || raw.eventId}`).digest("hex");
    if ((session.attention || []).some(request => request.id === id)) return;
    session.attention = [...(session.attention || []), { id, kind, toolId, createdAt: raw.at,
      ...(raw.at < this.started ? { baseline: true as const } : {}) }].slice(-16);
  }
  private async scan() {
    const remove: string[] = [];
    let files: string[] = [];
    try {
      const path = join(this.directory, "../claude-monitor-gap.json"), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
      const gap = JSON.parse(await readFile(path, "utf8"));
      if (gap.version !== 1 || !Number.isFinite(gap.through) || gap.through < 0) throw new Error();
      if (gap.through > this.missingThrough) { this.missingThrough = gap.through; this.dirty = true; }
    } catch (error: any) {
      if (error.code !== "ENOENT" && !this.gapUnconfirmed) { this.gapUnconfirmed = true; this.dirty = true; }
    }
    try {
      const all = (await readdir(this.directory)).filter(name => /^\d{13}-[a-f0-9-]{36}\.json$/.test(name)).sort();
      const present = new Set(all);
      for (const name of this.unreadable.keys()) if (!present.has(name)) this.unreadable.delete(name);
      // A locked/unreadable old file must not starve newer valid hook records.
      const index = all.findIndex(name => name > this.queueCursor);
      files = [...all.slice(index < 0 ? 0 : index), ...all.slice(0, Math.max(0, index))].slice(0, 64).sort();
      if (files.length) this.queueCursor = files.at(-1)!;
    }
    catch { /* Missing/private queue is retried without ending any run. */ }
    const inputs: { name: string; path: string; raw: any }[] = [], invalidAt: number[] = [];
    for (const name of files) {
      const path = join(this.directory, name);
      try {
        const raw = await this.input(path);
        this.unreadable.delete(name);
        if (!uuidPattern.test(raw?.eventId || "")) { remove.push(path); invalidAt.push(Number(name.slice(0, 13))); continue; }
        inputs.push({ name, path, raw });
      } catch (error) {
        if (error instanceof InvalidQueuedEvent) {
          this.unreadable.delete(name); remove.push(path); invalidAt.push(Number(name.slice(0, 13)));
        } else this.unreadable.set(name, { at: Number(name.slice(0, 13)) });
      }
    }
    if (invalidAt.length) {
      this.missingEvents = [...new Set([...this.missingEvents, ...invalidAt])].sort((a, b) => a - b).slice(-256);
      this.dirty = true;
    }
    // Malformed final files are permanent (writers rename atomically), not a
    // partially committing hook. Discard only the queue filename, never a
    // symlink target, and keep affected work uncertain rather than completing.
    for (const session of this.sessions.values()) if (session.pendingDone && invalidAt.some(at => at >= (session.turnAt || 0))) {
      session.unknownChildren = true;
      session.warning = "Claude monitor received invalid event data; completion is unconfirmed.";
      this.dirty = true; this.announce(session);
    }
    for (const { name, path, raw } of inputs) {
      try {
        if (["Stop", "SubagentStop", "StopFailure"].includes(raw.hook_event_name) &&
            [...this.unreadable.values()].some(event => event.at <= raw.at && (!event.sessionId || !event.owner ||
              event.sessionId === raw.session_id && ownerValid(raw.owner) && sameOwner(event.owner, raw.owner)))) {
          const session = this.sessions.get(raw.session_id);
          if (session) { session.warning = "Claude monitor is waiting for unreadable event data; completion is unconfirmed."; this.announce(session); }
          continue;
        }
        if (!this.processed.has(raw.eventId)) {
          const accepted = await this.event(raw);
          if (!accepted) this.missingEvents = [...new Set([...this.missingEvents, Number(name.slice(0, 13))])].sort((a, b) => a - b).slice(-256);
          this.processed.add(raw.eventId);
          while (this.processed.size > 2048) this.processed.delete(this.processed.values().next().value!);
          this.dirty = true;
        }
        remove.push(path);
      } catch {
        this.unreadable.set(name, { at: Number(name.slice(0, 13)),
          ...(uuidPattern.test(raw?.session_id || "") && ownerValid(raw?.owner) ? { sessionId: raw.session_id, owner: raw.owner } : {}) });
        /* Retry transient file/history failures without blocking unrelated owners. */
      }
    }
    for (const session of this.sessions.values()) {
      const online = !session.ended && await this.alive(session.owner);
      if (online !== session.online) { session.online = online; this.announce(session); }
      else if (session.online && await this.history(session)) this.announce(session);
    }
    if (this.dirty) {
      try { this.save(); } catch { return; }
    }
    // Persistence precedes observers/cleanup. Storage outages cannot invent
    // completion or lose a queued hook while monitoring continues to retry.
    const observations = this.pending; this.pending = [];
    for (const observation of observations) {
      try { this.receive(observation); } catch { /* Live receivers retain their own notification journal; a crash between state commit and delivery can lose this event. */ }
    }
    for (const path of remove) await unlink(path).catch(() => {});
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.task?.catch(() => {}); }
}
