import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CockpitStore } from "../cockpit-state/store.js";
import { initialState, type InputAttention, type RuntimeState, type Tunnel } from "../cockpit-state/types.js";
import { SessionError, SessionRepository, sessionKey, validateCwd, type SessionRepositoryOptions, type SessionCatalog } from "./sessions.js";
import { processAlive, readLocalJson, writeLocalJson, uuidPattern, type NativeSnapshot } from "./native-protocol.js";
import { connectorKey, isTunnel } from "../connectors/identity.js";
import { sessionLabel, promptLabel } from "../cockpit-state/selectors.js";
import type { InteractionAnswer } from "../cockpit-state/interactions.js";
import { CodexObserver, type CodexObservation } from "../connectors/codex-observer.js";
import { ClaudeObserver, type ClaudeObservation } from "../connectors/claude-observer.js";

interface Options {
  cwd: string; directory: string; preferencesPath: string; sessions?: SessionRepositoryOptions;
  catalog?: SessionCatalog;
  launch: (path: string, cwd: string, tunnel?: Tunnel, fresh?: boolean, name?: string) => Promise<void>;
  unregistered?: (knownPids: number[], tunnel?: Tunnel) => Promise<boolean>;
  alive?: (pid: number) => boolean;
  codexObservation?: { root?: string; attentionPath?: string };
  claudeObservation?: { directory: string; root?: string };
}
interface Watch { key: string; monitored: boolean; name?: string; cwd?: string; model?: string; tunnel?: Tunnel }
class ObservedRuntime {
  readonly store = new CockpitStore("");
  updatedAt = 0;
  private get name() { return this.store.state.session.tunnel === "claude" ? "Claude" : "Codex"; }
  async prompt(_text: string): Promise<void> { throw new SessionError(`Send this prompt in the original ${this.name} window.`, 409); }
  async interrupt(): Promise<void> { throw new SessionError(`Stop this run in the original ${this.name} window.`, 409); }
  async respond(_answer: InteractionAnswer): Promise<void> { throw new SessionError(`Answer in the original ${this.name} window.`, 409); }
}
class NativeRuntime {
  readonly store: CockpitStore;
  snapshot: NativeSnapshot;
  seenCompletion: number;
  seenRun: number;
  private sending = false;
  constructor(snapshot: NativeSnapshot, private host: NativeHost) {
    this.snapshot = snapshot; this.store = new CockpitStore(snapshot.state.session.cwd);
    this.seenCompletion = Math.max(0, ...snapshot.completions.map(item => item.id));
    this.seenRun = snapshot.runId;
  }
  async prompt(text: string) {
    if (!text.trim() || text.length > 32_000) throw new SessionError("Enter a prompt between 1 and 32,000 characters");
    if (["running", "waiting"].includes(this.store.state.main.status)) throw new SessionError("Agent is working", 409);
    await this.send("prompt", text);
  }
  async interrupt() { await this.send("interrupt"); }
  async respond(answer: InteractionAnswer) { await this.send("respond", undefined, answer); }
  private async send(type: "prompt" | "interrupt" | "respond", text?: string, answer?: InteractionAnswer) {
    if (this.sending) throw new SessionError("A terminal command is already pending", 409);
    if (!this.store.state.connected) throw new SessionError("The terminal is disconnected; reconnect it before sending a prompt", 409);
    const instance = this.snapshot.instance, id = randomUUID();
    const path = join(this.host.directory, `${instance}.command.json`), reply = join(this.host.directory, `${instance}.reply.json`);
    this.sending = true;
    try {
      writeLocalJson(path, { id, instance, key: this.store.state.session.key, type, text, answer,
        ...(type === "interrupt" ? { runId: this.snapshot.runId } : {}), expiresAt: Date.now() + 5000 });
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (this.snapshot.instance !== instance) throw new SessionError("The terminal changed; check its current session", 409);
        if (existsSync(reply)) {
          const result = readLocalJson(reply);
          if (result.id === id) { unlinkSync(reply); if (result.error) throw new SessionError(String(result.error)); return; }
        }
        await delay(100);
      }
      throw new SessionError("Terminal delivery was not confirmed; check the terminal before retrying", 504);
    } finally {
      this.sending = false;
      try { if (existsSync(path) && readLocalJson(path).id === id) unlinkSync(path); } catch {}
    }
  }
}

/** Monitor native terminals. Selecting a saved session never forks or owns its process. */
export class NativeHost {
  readonly concurrentSessions = true;
  readonly store: CockpitStore;
  readonly directory: string;
  private repository: SessionCatalog;
  private sessions = new Map<string, NativeRuntime>();
  private observed = new Map<string, ObservedRuntime>();
  private connectorOwned = new Map<string, number>();
  private codexObserver?: CodexObserver;
  private claudeObserver?: ClaudeObserver;
  private watches = new Map<string, Watch>();
  private selected?: string;
  private timer?: NodeJS.Timeout;
  private launching = new Map<string, number>();
  private newWindows = new Map<string, number>();
  private changing = false;
  private since = Date.now();
  private wasRunning = 0;
  private desktopOpenId?: string;
  private preferencesDirty = false;
  private attentionSignatures = new Map<string, string>();
  constructor(private options: Options) {
    this.directory = options.directory; this.store = new CockpitStore(options.cwd);
    this.repository = options.catalog || new SessionRepository(options.sessions);
    if (existsSync(options.preferencesPath)) {
      const data = readLocalJson(options.preferencesPath);
      if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error("Invalid monitoring preferences");
      this.desktopOpenId = typeof data.desktopOpenId === "string" ? data.desktopOpenId : undefined;
      for (const watch of data.sessions) {
        if (!/^[a-f0-9]{32}$/.test(watch.key) || typeof watch.monitored !== "boolean") throw new Error("Invalid monitoring preferences");
        this.watches.set(watch.key, watch);
      }
    }
  }
  async start() {
    this.scan(); this.timer = setInterval(() => {
      try { this.scan(); } catch { /* Retry monitoring without terminating native terminals on a transient local failure. */ }
    }, 300); this.timer.unref();
    if (this.options.codexObservation) {
      this.codexObserver = new CodexObserver(event => this.observeCodex(event), this.options.codexObservation);
      await this.codexObserver.start();
    }
    if (this.options.claudeObservation) {
      this.claudeObserver = new ClaudeObserver(event => this.observeClaude(event), this.options.claudeObservation);
      await this.claudeObserver.start();
    }
  }
  /** Existing connector instances always own their state/commands and completion delivery. */
  observeCodex(event: CodexObservation) {
    this.observeExternal(event);
  }
  observeClaude(event: ClaudeObservation) {
    this.observeExternal(event);
  }
  private observeExternal(event: CodexObservation | ClaudeObservation) {
    const key = event.state.session.key;
    if (!key) return;
    if (event.retired) { if (this.observed.delete(key)) this.publish(); return; }
    const ownedThrough = this.connectorOwned.get(key), native = this.sessions.get(key);
    if (ownedThrough !== undefined) {
      if (native && (this.options.alive || processAlive)(native.snapshot.pid) && native.snapshot.state.connected) return;
      // A later ordinary CLI launch may resume the same ID after its connector exits.
      // Require a new turn: delayed records from the old connector cannot notify twice.
      if (!event.activity || (event.state.main.startedAt || 0) <= ownedThrough) return;
      this.sessions.delete(key); this.connectorOwned.delete(key);
    }
    let runtime = this.observed.get(key);
    if (!runtime) { runtime = new ObservedRuntime(); this.observed.set(key, runtime); }
    const watch = this.watches.get(key);
    event.state.session.name ||= watch?.name;
    runtime.updatedAt = event.updatedAt;
    runtime.store.publish(event.state, { type: "monitoring.updated" });
    if (!watch || event.activity || watch.model !== event.state.session.model || watch.name !== event.state.session.name) {
      this.watches.set(key, { key, monitored: watch ? watch.monitored : true,
        ...event.state.session, tunnel: event.state.session.tunnel || "codex" });
      this.save(true);
    }
    this.publish();
    if (event.completion && this.watches.get(key)?.monitored) {
      this.store.publish(this.store.state, { type: "monitoring.settled", sessionKey: key, sessionId: event.state.session.id,
        session: sessionLabel(runtime.store.state), outcome: event.completion.outcome });
    }
  }
  private allRuntimes(): Map<string, NativeRuntime | ObservedRuntime> { return new Map<string, NativeRuntime | ObservedRuntime>([...this.observed, ...this.sessions]); }
  private updatedAt(runtime: NativeRuntime | ObservedRuntime) { return runtime instanceof NativeRuntime ? runtime.snapshot.updatedAt : runtime.updatedAt; }
  private save(background = false) {
    this.preferencesDirty = true;
    try {
      writeLocalJson(this.options.preferencesPath, { version: 1, desktopOpenId: this.desktopOpenId, sessions: [...this.watches.values()] });
      this.preferencesDirty = false;
    } catch (error) { if (!background) throw error; }
  }
  /** Apply startup defaults once per explicit manager opening, never on polling or reconnect. */
  async applyDesktopDefaults(openId: string, now = Date.now()) {
    if (!uuidPattern.test(openId)) throw new SessionError("A valid desktop openId is required");
    if (openId === this.desktopOpenId) return this.store.state;
    if (this.changing) throw new SessionError("A session is opening; retry shortly", 409);
    this.changing = true;
    try {
      const { sessions } = await this.listSessions();
      const cutoff = now - 24 * 60 * 60 * 1000;
      const recent = sessions.filter(session => Number.isFinite(session.updatedAt) && session.updatedAt >= cutoff && session.updatedAt <= now);
      const keys = new Set(recent.map(session => session.key));
      for (const watch of this.watches.values()) watch.monitored = keys.has(watch.key);
      for (const session of sessions) this.watches.set(session.key, {
        key: session.key, monitored: keys.has(session.key), name: session.name, cwd: session.cwd, model: session.model, tunnel: session.tunnel,
      });
      if (!this.selected || !keys.has(this.selected)) this.selected = recent[0]?.key;
      this.desktopOpenId = openId;
      // Membership only: neither launch closed terminals nor interrupt existing ones.
      this.save(); this.publish(); return this.store.state;
    } finally { this.changing = false; }
  }
  scan() {
    if (this.preferencesDirty) this.save(true);
    let files: string[] = [];
    try { files = readdirSync(this.directory).filter(name => /^\d+\.json$/.test(name)); } catch {}
    let changed = false;
    const snapshots = new Map<string, NativeSnapshot>();
    const retired: NativeSnapshot[] = [];
    // A session can be open in more than one Pi window. Heartbeats describe
    // liveness, not which window has the newest conversation. Pick once per
    // scan by real activity and retain the incumbent on ties.
    const alive = (snapshot: NativeSnapshot) => (this.options.alive || processAlive)(snapshot.pid);
    const online = (snapshot: NativeSnapshot) => alive(snapshot) && snapshot.state.connected && Date.now() - snapshot.at < 6000;
    const prefer = (candidate: NativeSnapshot, current: NativeSnapshot) => {
      if (candidate.pid === current.pid) return candidate.at >= current.at;
      if (!online(candidate)) return false;
      if (candidate.updatedAt > current.updatedAt) return true;
      // A newly reopened window may load a file whose mtime predates the old
      // owner's last event. It can take over after that owner exits, but an
      // already-idle duplicate cannot hide a temporarily missing heartbeat.
      return (!alive(current) || !current.state.connected) && (candidate.state.main.statusSince || 0) > current.at;
    };
    for (const file of files) {
      let snapshot: NativeSnapshot;
      try {
        snapshot = readLocalJson(join(this.directory, file));
        if (snapshot.version !== 1 || !uuidPattern.test(snapshot.instance) || String(snapshot.pid) + ".json" !== file ||
          !Number.isSafeInteger(snapshot.pid) || snapshot.pid < 1 || !Number.isFinite(snapshot.at) || !Number.isFinite(snapshot.updatedAt) ||
          !/^[a-f0-9]{32}$/.test(snapshot.state?.session?.key || "") || !Array.isArray(snapshot.completions) || !Array.isArray(snapshot.state.transcript)) continue;
        const tunnel = snapshot.state.session.tunnel || "pi";
        if (!isTunnel(tunnel)) continue;
        if (tunnel === "pi" && snapshot.sessionFile && sessionKey(snapshot.sessionFile) !== snapshot.state.session.key) continue;
        if (tunnel !== "pi" && (typeof snapshot.state.session.id !== "string" || connectorKey(tunnel, snapshot.state.session.id) !== snapshot.state.session.key)) continue;
      } catch { continue; }
      const key = snapshot.state.session.key!;
      const alive = (this.options.alive || processAlive)(snapshot.pid);
      if (!alive && Date.now() - snapshot.at > 6000 && retired.length < 16) retired.push(snapshot);
      const runtime = this.sessions.get(key);
      // Old files are not evidence of a running window.
      if (!runtime && (!alive || !snapshot.state.connected || Date.now() - snapshot.at > 6000)) continue;
      if (runtime && runtime.snapshot.instance !== snapshot.instance && !prefer(snapshot, runtime.snapshot)) continue;
      const current = snapshots.get(key);
      if (!current || prefer(snapshot, current)) snapshots.set(key, snapshot);
    }
    for (const [key, snapshot] of snapshots) {
      const alive = (this.options.alive || processAlive)(snapshot.pid);
      let runtime = this.sessions.get(key);
      const fresh = !runtime || runtime.snapshot.instance !== snapshot.instance;
      if (!runtime) { runtime = new NativeRuntime(snapshot, this); this.sessions.set(key, runtime); }
      else if (fresh) { runtime.seenCompletion = Math.max(0, ...snapshot.completions.map(item => item.id)); runtime.seenRun = snapshot.runId; }
      runtime = runtime!;
      this.connectorOwned.set(key, snapshot.at); this.observed.delete(key);
      const online = alive && snapshot.state.connected && Date.now() - snapshot.at < 6000;
      if (online && snapshot.launchId && this.newWindows.has(snapshot.launchId)) {
        this.selected = key; this.newWindows.delete(snapshot.launchId); changed = true;
      }
      // The same native window can /resume or /new. It owns only its current session.
      if (online) for (const [otherKey, other] of this.sessions) if (otherKey !== key && other.snapshot.pid === snapshot.pid && other.store.state.connected) {
        other.snapshot.state = { ...other.snapshot.state, connected: false };
        other.store.publish({ ...other.store.state, connected: false }, { type: "monitoring.updated" }); changed = true;
      }
      const newActivity = snapshot.runId > runtime.seenRun;
      const watch = this.watches.get(key);
      snapshot.state.session.name ||= watch?.name || promptLabel(snapshot.state.transcript.find(entry => entry.role === "user")?.text || "") || undefined;
      if ((!watch && online) || newActivity || (watch && (watch.name !== snapshot.state.session.name || watch.model !== snapshot.state.session.model))) {
        this.watches.set(key, { key, monitored: watch ? watch.monitored : true, name: snapshot.state.session.name, cwd: snapshot.state.session.cwd,
          model: snapshot.state.session.model, tunnel: snapshot.state.session.tunnel || "pi" }); this.save(true);
      }
      runtime.seenRun = Math.max(runtime.seenRun, snapshot.runId);
      if (fresh || runtime.snapshot.state.revision !== snapshot.state.revision || runtime.store.state.connected !== online) {
        runtime.store.publish({ ...snapshot.state, connected: online }, { type: "monitoring.updated" }); changed = true;
      }
      runtime.snapshot = snapshot;
      if (online) { this.launching.delete(key); if (!this.selected) this.selected = key; }
      for (const completion of snapshot.completions) {
        if (!Number.isFinite(completion.id) || completion.id <= runtime.seenCompletion) continue;
        runtime.seenCompletion = completion.id;
        if (this.watches.get(key)?.monitored && ["completed", "interrupted", "failed"].includes(completion.outcome)) {
          this.publish();
          this.store.publish(this.store.state, { type: "monitoring.settled", sessionId: snapshot.state.session.id, sessionKey: key,
            session: sessionLabel(snapshot.state), outcome: completion.outcome });
        }
      }
    }
    // A vanished heartbeat is a connection loss, never a completion or unwatch.
    for (const runtime of this.sessions.values()) if (runtime.store.state.connected && Date.now() - runtime.snapshot.at > 6000) {
      runtime.store.publish({ ...runtime.store.state, connected: false }, { type: "monitoring.updated" }); changed = true;
    }
    for (const [key, runtime] of this.sessions) if (key !== this.selected && !runtime.store.state.connected && !(this.options.alive || processAlive)(runtime.snapshot.pid)) {
      this.sessions.delete(key); changed = true;
    }
    for (const [id, deadline] of this.newWindows) if (Date.now() > deadline) this.newWindows.delete(id);
    if (changed || !this.store.state.monitoring) this.publish();
    // Final completions above must be consumed before discarding a dead owner's
    // heartbeat. Saved conversations and watch membership live elsewhere.
    for (const snapshot of retired) {
      try {
        if ((this.options.alive || processAlive)(snapshot.pid)) continue;
        const path = join(this.directory, `${snapshot.pid}.json`), current = readLocalJson(path);
        if (current.instance !== snapshot.instance || current.pid !== snapshot.pid || current.at !== snapshot.at) continue;
        unlinkSync(path);
        for (const suffix of ["command", "reply"]) {
          try { unlinkSync(join(this.directory, `${snapshot.instance}.${suffix}.json`)); } catch {}
        }
      } catch { /* A concurrently replaced/locked file is retried on the next scan. */ }
    }
  }
  private publish() {
    const runtimes = this.allRuntimes();
    for (const [key, runtime] of runtimes) this.publishAttention(key, runtime.store.state);
    const entries = [...runtimes].map(([key, runtime]) => ({ key, name: sessionLabel(runtime.store.state),
      cwd: runtime.store.state.session.cwd, model: runtime.store.state.session.model, tunnel: runtime.store.state.session.tunnel || "pi",
      status: runtime.store.state.connected ? runtime.store.state.main.status : "offline" as const,
      monitored: this.watches.get(key)?.monitored === true, current: key === this.selected, updatedAt: this.updatedAt(runtime) }));
    for (const watch of this.watches.values()) if (watch.monitored && !runtimes.has(watch.key)) entries.push({ key: watch.key,
      name: watch.name || "Saved session", cwd: watch.cwd || this.options.cwd, model: watch.model, tunnel: watch.tunnel || "pi",
      status: "offline", monitored: true, current: watch.key === this.selected, updatedAt: 0 });
    const running = entries.filter(item => item.monitored && item.status === "running").length;
    if ((running === 0) !== (this.wasRunning === 0)) this.since = Date.now();
    this.wasRunning = running;
    const current = this.selected ? runtimes.get(this.selected)?.store.state : undefined;
    const fallback = initialState(this.options.cwd), watch = this.selected ? this.watches.get(this.selected) : undefined;
    if (watch) fallback.session = { key: watch.key, name: watch.name, cwd: watch.cwd || this.options.cwd, model: watch.model, tunnel: watch.tunnel || "pi" };
    this.store.publish({ ...(current || fallback), nativeTerminals: true, monitoring: { running, watched: entries.filter(item => item.monitored).length, since: this.since, sessions: entries } }, { type: "monitoring.updated" });
  }
  private publishAttention(key: string, state: RuntimeState) {
    // Losing transport is not a resolved question. Reconcile only a verified
    // online snapshot; the journal retains its durable identity over reconnect.
    if (!state.connected && this.watches.get(key)?.monitored) return;
    const broker = (state.interactions || []).filter(item => item.kind !== "menu" && item.expiresAt > Date.now());
    const requests: InputAttention[] = this.watches.get(key)?.monitored ? [
      ...broker.map(item => ({ id: item.id, kind: item.kind as "approval" | "question", createdAt: item.createdAt, expiresAt: item.expiresAt })),
      ...(state.attention || []),
    ].filter(item => typeof item.id === "string" && item.id.length > 0 && item.id.length <= 300 &&
      ["approval", "question", "terminal-input"].includes(item.kind) &&
      (item.createdAt === undefined || (Number.isFinite(item.createdAt) && item.createdAt <= Date.now() + 60_000)) &&
      (item.expiresAt === undefined || (Number.isFinite(item.expiresAt) && item.expiresAt > Date.now())))
      .slice(0, 16).map(item => ({ ...item,
        id: createHash("sha256").update(key + ":" + item.kind + ":" + item.id).digest("hex"),
      })) : [];
    const signature = JSON.stringify(requests);
    if (this.attentionSignatures.get(key) === signature) return;
    this.attentionSignatures.set(key, signature);
    this.store.publish(this.store.state, { type: "monitoring.attention", sessionKey: key,
      sessionId: state.session.id, session: sessionLabel(state), requests });
  }
  getRuntime(key: string) {
    const runtime = this.sessions.get(key) || this.observed.get(key);
    if (!runtime) throw new SessionError("Terminal not connected. Pi: run /reload. Codex/Claude: reopen with the Terminal+ connector when ready.", 404);
    return runtime;
  }
  prompt(text: string) { if (!this.selected) throw new SessionError("Choose a session first"); return this.getRuntime(this.selected).prompt(text); }
  interrupt() { if (!this.selected) throw new SessionError("Choose a session first"); return this.getRuntime(this.selected).interrupt(); }
  async listSessions(cwd?: string) {
    this.scan();
    const result = await this.repository.list(cwd);
    const rows = new Map(result.sessions.map(session => [session.key, session]));
    for (const [key, runtime] of this.allRuntimes()) {
      const state = runtime.store.state;
      if (cwd && state.session.cwd !== cwd) continue;
      const previous = rows.get(key);
      // Prefer the native session title when the catalog has learned a user rename.
      if (runtime instanceof ObservedRuntime && previous?.name) {
        state.session.name = previous.name;
        const watch = this.watches.get(key);
        if (watch && watch.name !== previous.name) { watch.name = previous.name; this.save(); }
      }
      rows.set(key, { ...previous, key, id: state.session.id || key, name: state.session.name || previous?.name,
        cwd: state.session.cwd, model: state.session.model || previous?.model, tunnel: state.session.tunnel || "pi",
        updatedAt: Math.max(this.updatedAt(runtime), previous?.updatedAt || 0),
        messageCount: state.transcript.length, runtimeStatus: state.connected ? state.main.status : "offline", live: state.connected,
        owned: false, active: key === this.selected, monitored: this.watches.get(key)?.monitored === true });
    }
    result.sessions = [...rows.values()].map(session => ({ ...session, monitored: this.watches.get(session.key)?.monitored === true,
      active: session.key === this.selected })).sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    return result;
  }
  sessionHistory(key: string) { return this.repository.history(key); }
  async resumeSession(key: string) { await this.openMonitoredSession(key); }
  async selectWatchedSession(key: string) { await this.openMonitoredSession(key, true); }
  async openMonitoredSession(key: string, watchedOnly = false) {
    return this.openSession(key, watchedOnly);
  }
  private async openSession(key: string, watchedOnly: boolean, newlyCreated = false) {
    if (this.changing) throw new SessionError("A session is opening", 409);
    this.changing = true;
    try {
      this.scan();
      if (watchedOnly && !this.watches.get(key)?.monitored) throw new SessionError("Session is no longer watched. Refresh Sessions.", 409);
      const runtime = this.sessions.get(key);
      const observer = this.observed.get(key);
      if (!runtime && observer) {
        if (watchedOnly && !this.watches.get(key)?.monitored) throw new SessionError("Session is no longer watched. Refresh Sessions.", 409);
        this.selected = key;
        this.watches.set(key, { key, monitored: true, ...observer.store.state.session });
        this.save(); this.publish(); return key;
      }
      if (!runtime?.store.state.connected && (this.launching.get(key) || 0) < Date.now()) {
        // A live process with a stale bridge is not permission to open a second writer.
        const original = await this.repository.original(key);
        if (runtime && (this.options.alive || processAlive)(runtime.snapshot.terminalPid || runtime.snapshot.pid) && runtime.snapshot.state.connected)
          throw new SessionError("This terminal is still open. Reconnect its monitor before opening another window.", 409);
        if (!newlyCreated && !original.fresh && await this.options.unregistered?.([...this.sessions.values()].flatMap(item => [item.snapshot.pid, item.snapshot.terminalPid || item.snapshot.pid]), original.tunnel || "pi"))
          throw new SessionError("An existing terminal has not connected. Pi: run /reload. Codex/Claude: reopen through Terminal+ when idle.", 409);
        await this.options.launch(original.path, original.cwd, original.tunnel || "pi", newlyCreated || original.fresh);
        this.launching.set(key, Date.now() + 15_000);
      }
      const summary = runtime?.store.state.connected ? runtime.store.state.session : (await this.repository.history(key)).session;
      if (watchedOnly && !this.watches.get(key)?.monitored) throw new SessionError("Session is no longer watched. Refresh Sessions.", 409);
      this.selected = key;
      this.watches.set(key, { key, monitored: true, name: summary.name, cwd: summary.cwd, model: summary.model, tunnel: summary.tunnel || "pi" }); this.save(); this.publish();
      return key;
    } finally { this.changing = false; }
  }
  async newSession(options: { cwd?: string; name?: string; tunnel?: Tunnel } = {}) {
    if (options.name !== undefined && (!options.name.trim() || options.name.length > 128)) throw new SessionError("Invalid session name");
    if (this.changing) throw new SessionError("A session is opening", 409);
    this.scan();
    const cwd = await validateCwd(options.cwd || this.store.state.session.cwd);
    if (options.tunnel === "codex") {
      // The native TUI creates the session: an empty app-server thread has no
      // persisted rollout to resume in another process until its first turn.
      const id = randomUUID(); this.newWindows.set(id, Date.now() + 120_000);
      try { await this.options.launch(id, cwd, "codex", true, options.name?.trim()); }
      catch (error) { this.newWindows.delete(id); throw error; }
      return;
    }
    const created = await this.repository.create(cwd, options.name?.trim(), options.tunnel);
    // Creation reserves a distinct native identity/file. Unrelated terminals
    // cannot own it; only this internal path may bypass the resume guard.
    await this.openSession(created.key, false, true);
  }
  async setMonitored(key: string, monitored: boolean) {
    const summary = (await this.listSessions()).sessions.find(session => session.key === key);
    if (!summary && !this.watches.has(key)) throw new SessionError("Unknown session", 404);
    const previous = this.watches.get(key);
    this.watches.set(key, { key, monitored, name: summary?.name || previous?.name, cwd: summary?.cwd || previous?.cwd,
      model: summary?.model || previous?.model, tunnel: summary?.tunnel || previous?.tunnel || "pi" }); this.save(); this.publish();
  }
  async stop() { clearInterval(this.timer); await this.codexObserver?.stop(); await this.claudeObserver?.stop(); await this.repository.close?.(); /* Native terminals belong to the user, never the monitor. */ }
}
