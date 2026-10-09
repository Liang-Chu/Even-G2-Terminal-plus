import { initialState, type RuntimeState, type HostSource } from "../../../../packages/cockpit-state/types.js";
import { BridgeClient, type BridgeApi, type Connection, type ConnectionStatus } from "./client.js";
import type { SessionSummary } from "../sessions/panel.js";
import { mergeSessionState } from "../sessions/live.js";

interface Completion { id: number; outcome: string; session: string }
interface Transport extends BridgeApi {
  verify(): Promise<RuntimeState>; connect(): void; disconnect(): void; reconnect(): void; setViewedSession(key?: string): void;
}
type Factory = (connection: Connection, state: (state: RuntimeState) => void, online: (online: boolean, error?: string, status?: ConnectionStatus) => void, completion: (value: Completion) => void) => Transport;
interface Host { connection: Connection; client: Transport; state?: RuntimeState; catalog?: SessionSummary[]; info?: HostSource; online: boolean; error?: string;
  status?: ConnectionStatus;
  metadataDue: number; metadataPending?: boolean; metadataFailures?: number; metadataTimer?: ReturnType<typeof setTimeout> }
const namespace = (url: string) => btoa(url).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export const scopedKey = (url: string, key: string) => namespace(url) + ":" + key;

/** The UI connects directly to each host. Keys and prompts never pass through a different backend. */
export class FleetClient implements BridgeApi {
  private entries = new Map<string, Host>();
  private active?: string;
  private viewed?: string;
  private suspended = false;
  private revision = 0;
  private selectionRevision = 0;
  private since = Date.now();
  private phase = "";
  constructor(private onState: (state: RuntimeState) => void, private onConnection: (online: boolean, message?: string) => void,
    private onCompletion: (value: Completion) => void, private onSelect: (url: string) => void = () => {},
    private factory: Factory = (...args) => new BridgeClient(...args)) {}

  activeUrl() { return this.active; }
  activeConnection() { return this.active ? this.entries.get(this.active)?.connection : undefined; }
  hosts(): HostSource[] { return [...this.entries.values()].map(host => this.source(host)); }
  connections() { return [...this.entries.values()].map(host => host.connection); }
  async requestFrom(url: string, path: string, data?: unknown, timeout?: number) {
    const host = this.requireOnline(this.entries.get(url));
    const result = await host.client.request(path, data, timeout);
    if (this.entries.get(url) !== host) throw new Error("Computer connection changed. Try again.");
    return result;
  }
  private source(host: Host): HostSource {
    return { ...(host.info || { id: namespace(host.connection.url), name: new URL(host.connection.url).hostname,
      nameSource: "address" as const, warning: "Device name unavailable; retrying while connected." }),
      url: host.connection.url, online: host.online, ...host.status, ...(host.error ? { warning: host.error } : {}) };
  }
  private target(key: string) {
    const decoded = decodeURIComponent(key), split = decoded.lastIndexOf(":");
    const prefix = decoded.slice(0, split), native = decoded.slice(split + 1);
    const host = [...this.entries.values()].find(entry => namespace(entry.connection.url) === prefix);
    if (!host || !/^[a-f0-9]{32}$/.test(native)) throw new Error("Session source was removed or changed. Refresh the session list.");
    return { host, key: native };
  }
  private requireOnline(host?: Host): Host {
    if (!host) throw new Error("Choose a computer first.");
    if (!host.online) throw new Error(`${this.source(host).name} is offline. Watch is retained; no command was sent.`);
    return host;
  }
  private scopeState(host: Host, state: RuntimeState): RuntimeState {
    const source = this.source(host), scope = (key: string) => scopedKey(host.connection.url, key);
    return { ...state, source, connected: host.online && state.connected,
      session: { ...state.session, key: state.session.key ? scope(state.session.key) : undefined },
      monitoring: state.monitoring && { ...state.monitoring, sessions: state.monitoring.sessions.map(session => ({ ...session,
        key: scope(session.key), source, status: host.online ? session.status : "offline", current: host.connection.url === this.active && session.current })) } };
  }
  snapshot(): RuntimeState {
    const selected = this.active ? this.entries.get(this.active) : undefined;
    const state = selected ? this.scopeState(selected, selected.state || initialState()) : initialState();
    const sessions = [...this.entries.values()].flatMap(host => host.state ? this.scopeState(host, host.state).monitoring?.sessions || [] : []);
    const running = sessions.filter(s => s.monitored && s.status === "running").length;
    const phase = `${running > 0}:${this.hosts().filter(host => !host.online).length}`;
    if (phase !== this.phase) { this.phase = phase; this.since = Date.now(); }
    return { ...state, revision: this.revision, hosts: this.hosts(), nativeTerminals: true,
      monitoring: { running, watched: sessions.filter(s => s.monitored).length, since: this.since, sessions } };
  }
  private emit() {
    this.revision++;
    const sources = this.hosts(), online = sources.filter(host => host.online).length;
    const offline = sources.filter(host => !host.online);
    const rejected = offline.filter(host => host.connectionState === "key-rejected");
    const retrying = offline.filter(host => ["connecting", "retrying"].includes(host.connectionState || ""));
    const exhausted = offline.filter(host => !rejected.includes(host) && !retrying.includes(host));
    const messages = rejected.map(host => `${host.name}: ${host.warning}`);
    if (retrying.length) messages.push(`${retrying.map(host => host.name).join(", ")} offline · reconnecting; Watch retained`);
    if (exhausted.length) messages.push(`${exhausted.map(host => host.name).join(", ")} offline · reconnect manually; Watch retained`);
    this.syncPresence(); this.onState(this.snapshot());
    const selected = this.active ? this.entries.get(this.active) : undefined;
    this.onConnection(online > 0, !selected?.online && messages.length ? messages.join(" · ") : undefined);
  }
  private scheduleMetadata(host: Host, wait: number) {
    clearTimeout(host.metadataTimer);
    host.metadataTimer = undefined;
    if (this.suspended || !host.online || this.entries.get(host.connection.url) !== host) return;
    host.metadataDue = Date.now() + wait;
    host.metadataTimer = setTimeout(() => { host.metadataTimer = undefined; void this.metadata(host); }, wait);
    host.metadataTimer.unref?.();
  }
  private async metadata(host: Host) {
    if (this.suspended || !host.online || host.metadataPending || this.entries.get(host.connection.url) !== host) return;
    if (Date.now() < host.metadataDue) { this.scheduleMetadata(host, host.metadataDue - Date.now()); return; }
    clearTimeout(host.metadataTimer); host.metadataTimer = undefined; host.metadataPending = true;
    let wait: number | undefined;
    try {
      const value = await host.client.request("/api/host", undefined, 7000) as HostSource;
      if (!value || typeof value.id !== "string" || typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || !["tailscale", "hostname"].includes(value.nameSource))
        throw new Error("Host identity unavailable");
      if (this.suspended || !host.online || this.entries.get(host.connection.url) !== host) return;
      const changed = !host.info || JSON.stringify(value) !== JSON.stringify(host.info);
      host.info = value; host.metadataFailures = 0; wait = 60_000;
      // Polling an unchanged name must not trigger extra G2 renders or rebuilds.
      if (changed) this.emit();
    } catch {
      // Retry independently of conversation events: idle hosts may only send
      // SSE heartbeats. Keep the last verified name through a temporary failure.
      host.metadataFailures = Math.min((host.metadataFailures || 0) + 1, 6);
      wait = Math.min(60_000, 2000 * 2 ** (host.metadataFailures - 1));
    } finally {
      host.metadataPending = false;
      if (wait !== undefined) this.scheduleMetadata(host, wait);
    }
  }
  async add(connection: Connection, restoring = false, select = true, currentAttempt = () => true, replaceUrl?: string) {
    const replacement = replaceUrl && replaceUrl !== connection.url ? this.entries.get(replaceUrl) : undefined;
    if (replaceUrl && replaceUrl !== connection.url && (!replacement || restoring))
      throw new Error("The saved computer changed. Refresh its connection before editing the address.");
    const host = { connection, online: false, metadataDue: 0, status: { connectionState: "connecting", retryAttempt: 0 } } as Host;
    const current = () => this.entries.get(connection.url) === host;
    host.client = this.factory(connection, state => {
      if (!current()) return;
      host.state = state; this.emit(); void this.metadata(host);
    }, (online, error, status) => {
      if (!current()) return;
      host.online = online; host.error = error;
      host.status = status || { connectionState: online ? "online" : error?.startsWith("Connection key rejected.") ? "key-rejected" : "offline", retryAttempt: host.status?.retryAttempt || 0 };
      if (!online) { clearTimeout(host.metadataTimer); host.metadataTimer = undefined; }
      this.emit(); if (online) void this.metadata(host);
    }, completion => { if (current()) this.onCompletion({ ...completion, session: `${this.source(host).name} · ${completion.session}` }); });
    if (!restoring) {
      host.state = await host.client.verify();
      try {
        const info = await host.client.request("/api/host", undefined, 7000) as HostSource;
        if (typeof info?.id === "string" && typeof info.name === "string" && ["tailscale", "hostname"].includes(info.nameSource)) {
          const duplicate = [...this.entries.values()].find(other => other.connection.url !== connection.url &&
            other.connection.url !== replaceUrl && other.info?.id === info.id);
          if (duplicate) throw new Error(`This computer is already saved at ${duplicate.connection.url}. Edit or remove that entry first.`);
          host.info = info; host.metadataDue = Date.now() + 60_000;
        }
      } catch (error) {
        if (error instanceof Error && (error.message.startsWith("This computer is already saved") || error.message.startsWith("Connection key rejected."))) throw error;
      }
    }
    if (replacement && (!host.info || !replacement.info || host.info.id !== replacement.info.id))
      throw new Error("The new address does not identify the saved computer. Use Connect another computer for a different device.");
    if (!currentAttempt()) throw new Error("Connection attempt was replaced");
    if (replacement && this.entries.get(replaceUrl!) !== replacement)
      throw new Error("The saved computer changed while its new address was being verified. Try again.");
    const previous = this.entries.get(connection.url);
    clearTimeout(previous?.metadataTimer); previous?.client.disconnect();
    if (replacement) {
      clearTimeout(replacement.metadataTimer); replacement.client.disconnect(); this.entries.delete(replaceUrl!);
    }
    this.entries.set(connection.url, host);
    if (!this.active || select || replacement?.connection.url === this.active) this.choose(connection.url);
    if (!this.suspended) host.client.connect();
    this.emit();
  }
  choose(url: string) {
    if (!this.entries.has(url)) throw new Error("Computer not saved");
    this.selectionRevision++;
    const changed = this.active !== url;
    this.active = url;
    if (changed) { this.viewed = undefined; this.onSelect(url); }
    this.emit();
  }
  remove(url: string) {
    const host = this.entries.get(url);
    clearTimeout(host?.metadataTimer); host?.client.disconnect(); this.entries.delete(url);
    if (this.active === url) { this.selectionRevision++; this.active = this.entries.keys().next().value; this.viewed = undefined; if (this.active) this.onSelect(this.active); }
    this.emit();
  }
  setViewedSession(key?: string) { this.viewed = key; this.syncPresence(); }
  private syncPresence() {
    for (const host of this.entries.values()) {
      let key: string | undefined;
      if (this.viewed && host.online && !this.suspended) {
        try { const target = this.target(this.viewed); if (target.host === host && host.connection.url === this.active) key = target.key; } catch {}
      }
      host.client.setViewedSession(key);
    }
  }
  connect() { this.suspended = false; for (const host of this.entries.values()) host.client.connect(); }
  /** Visibility/page restoration preserves every computer's existing retry cycle. */
  resume() { this.connect(); }
  disconnect() { this.suspended = true; for (const host of this.entries.values()) {
    host.online = false;
    if (host.status?.connectionState !== "key-rejected") host.status = { connectionState: "offline", retryAttempt: host.status?.retryAttempt || 0 };
    clearTimeout(host.metadataTimer); host.metadataTimer = undefined; host.client.disconnect();
  } }
  /** Only this computer receives a fresh automatic retry budget. */
  reconnectHost(url: string) {
    const host = this.entries.get(url);
    if (!host) throw new Error("Computer not saved");
    this.suspended = false; host.online = false; host.error = undefined;
    host.status = { connectionState: "connecting", retryAttempt: 0 };
    clearTimeout(host.metadataTimer); host.metadataTimer = undefined;
    host.client.reconnect(); this.emit();
  }
  reconnect() { for (const url of this.entries.keys()) this.reconnectHost(url); }
  private async catalog() {
    await Promise.all([...this.entries.values()].map(async host => {
      if (!host.online) return;
      try {
        const result = await host.client.request("/api/sessions", undefined, 8000);
        if (this.entries.get(host.connection.url) !== host || !Array.isArray(result.sessions)) return;
        host.catalog = result.sessions;
      } catch { /* Retain cached rows and membership from this host during outages. */ }
    }));
    const sessions = [...this.entries.values()].flatMap(host => {
      const rows = host.state ? mergeSessionState(host.catalog || [], host.state) : host.catalog || [];
      return rows.map(row => ({ ...row, key: scopedKey(host.connection.url, row.key), source: this.source(host),
        live: host.online && row.live, runtimeStatus: host.online ? row.runtimeStatus : "offline" as const }));
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
    return { sessions, skipped: 0, hosts: this.hosts() };
  }
  async request(path: string, data?: unknown, timeout?: number): Promise<any> {
    if (path === "/api/state") return this.snapshot();
    if (path === "/api/sessions") return this.catalog();
    const body = data && typeof data === "object" ? { ...data as Record<string, unknown> } : undefined;
    if (["/api/prompt", "/api/interaction/respond"].includes(path) && typeof body?.sessionKey !== "string")
      throw new Error("Choose the target session before sending a command.");
    let host: Host | undefined, routed = path, switchHost = false;
    const route = /^\/api\/(runtime|sessions)\/([^/]+)\/(state|history|prompt|interrupt|monitor|terminal)$/.exec(path);
    if (route) {
      const target = this.target(route[2]); host = target.host;
      routed = `/api/${route[1]}/${target.key}/${route[3]}`; switchHost = route[3] === "terminal";
    } else if (path === "/api/session/resume" && typeof body?.key === "string") {
      const target = this.target(body.key); host = target.host; body.key = target.key; switchHost = true;
    } else if (typeof body?.sessionKey === "string") {
      const target = this.target(body.sessionKey); host = target.host; body.sessionKey = target.key;
    } else if (path === "/api/session/new") {
      host = this.entries.get(typeof body?.sourceUrl === "string" ? body.sourceUrl : this.active || "");
      if (body) delete body.sourceUrl; switchHost = true;
    } else host = this.active ? this.entries.get(this.active) : undefined;
    host = this.requireOnline(host);
    // The latest opening request or deliberate choice owns the viewer, even if
    // an older command finishes later or the same computer is chosen again.
    const selection = switchHost ? ++this.selectionRevision : this.selectionRevision;
    const result = await host.client.request(routed, body === undefined ? data : body, timeout);
    if (this.entries.get(host.connection.url) !== host) throw new Error("Computer was removed or reconfigured while the request was in flight. Check its native terminal before retrying.");
    if (route?.[3] === "history") return { ...result, session: { ...result.session, key: scopedKey(host.connection.url, result.session.key), source: this.source(host) } };
    if (switchHost) {
      if (selection !== this.selectionRevision) return this.snapshot();
      const state = result?.session && result?.main ? result : await host.client.request("/api/state");
      if (this.entries.get(host.connection.url) !== host) throw new Error("Computer was removed or reconfigured while the request was in flight. Check its native terminal before retrying.");
      if (selection !== this.selectionRevision) return this.snapshot();
      host.state = state;
      this.choose(host.connection.url);
    } else if (result?.session && result?.main) host.state = result;
    this.emit();
    return switchHost || route?.[3] === "monitor" ? this.snapshot() : result;
  }
}
