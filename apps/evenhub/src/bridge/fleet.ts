import { initialState, type RuntimeState, type HostSource } from "../../../../packages/cockpit-state/types.js";
import { BridgeClient, type BridgeApi, type Connection } from "./client.js";
import type { SessionSummary } from "../sessions/panel.js";
import { mergeSessionState } from "../sessions/live.js";

interface Completion { id: number; outcome: string; session: string }
interface Transport extends BridgeApi {
  verify(): Promise<RuntimeState>; connect(): void; disconnect(): void; reconnect(): void; setViewedSession(key?: string): void;
}
type Factory = (connection: Connection, state: (state: RuntimeState) => void, online: (online: boolean, error?: string) => void, completion: (value: Completion) => void) => Transport;
interface Host { connection: Connection; client: Transport; state?: RuntimeState; catalog?: SessionSummary[]; info?: HostSource; online: boolean; error?: string; metadataAt: number }
const namespace = (url: string) => btoa(url).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export const scopedKey = (url: string, key: string) => namespace(url) + ":" + key;

/** The UI connects directly to each host. Keys and prompts never pass through a different backend. */
export class FleetClient implements BridgeApi {
  private entries = new Map<string, Host>();
  private active?: string;
  private viewed?: string;
  private suspended = false;
  private revision = 0;
  private since = Date.now();
  private phase = "";
  constructor(private onState: (state: RuntimeState) => void, private onConnection: (online: boolean, message?: string) => void,
    private onCompletion: (value: Completion) => void, private onSelect: (url: string) => void = () => {},
    private factory: Factory = (...args) => new BridgeClient(...args)) {}

  activeUrl() { return this.active; }
  activeConnection() { return this.active ? this.entries.get(this.active)?.connection : undefined; }
  hosts(): HostSource[] { return [...this.entries.values()].map(host => this.source(host)); }
  connections() { return [...this.entries.values()].map(host => host.connection); }
  async requestFrom(url: string, path: string, data?: unknown) {
    const host = this.requireOnline(this.entries.get(url));
    const result = await host.client.request(path, data);
    if (this.entries.get(url) !== host) throw new Error("Computer connection changed. Try again.");
    return result;
  }
  private source(host: Host): HostSource {
    return { ...(host.info || { id: namespace(host.connection.url), name: new URL(host.connection.url).hostname,
      nameSource: "address" as const, warning: "Tailscale name not available yet. Update/connect this backend to retrieve it." }),
      url: host.connection.url, online: host.online, ...(host.error ? { warning: host.error } : {}) };
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
    const rejected = offline.filter(host => host.warning?.startsWith("Connection key rejected."));
    const retrying = offline.filter(host => !rejected.includes(host));
    const messages = rejected.map(host => `${host.name}: ${host.warning}`);
    if (retrying.length) messages.push(`${retrying.map(host => host.name).join(", ")} offline · reconnecting; Watch retained`);
    this.syncPresence(); this.onState(this.snapshot());
    this.onConnection(online > 0, messages.length ? messages.join(" · ") : undefined);
  }
  private async metadata(host: Host) {
    if (Date.now() - host.metadataAt < 60_000) return;
    host.metadataAt = Date.now();
    try {
      const value = await host.client.request("/api/host", undefined, 7000) as HostSource;
      if (!value || typeof value.id !== "string" || typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || !["tailscale", "hostname"].includes(value.nameSource)) return;
      if (this.entries.get(host.connection.url) !== host) return;
      host.info = value; this.emit();
    } catch { /* Saved hosts keep reconnecting; never forget one because metadata is temporarily unavailable. */ }
  }
  async add(connection: Connection, restoring = false, select = true, currentAttempt = () => true) {
    const host = { connection, online: false, metadataAt: 0 } as Host;
    const current = () => this.entries.get(connection.url) === host;
    host.client = this.factory(connection, state => {
      if (!current()) return;
      host.state = state; this.emit(); void this.metadata(host);
    }, (online, error) => {
      if (!current()) return;
      host.online = online; host.error = error; this.emit(); if (online) void this.metadata(host);
    }, completion => { if (current()) this.onCompletion({ ...completion, session: `${this.source(host).name} · ${completion.session}` }); });
    if (!restoring) {
      host.state = await host.client.verify();
      try {
        const info = await host.client.request("/api/host", undefined, 7000) as HostSource;
        if (typeof info?.id === "string" && typeof info.name === "string" && ["tailscale", "hostname"].includes(info.nameSource)) {
          const duplicate = [...this.entries.values()].find(other => other.connection.url !== connection.url && other.info?.id === info.id);
          if (duplicate) throw new Error(`This computer is already saved at ${duplicate.connection.url}. Edit or remove that entry first.`);
          host.info = info; host.metadataAt = Date.now();
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("This computer is already saved")) throw error;
      }
    }
    if (!currentAttempt()) throw new Error("Connection attempt was replaced");
    this.entries.get(connection.url)?.client.disconnect();
    this.entries.set(connection.url, host);
    if (!this.active || select) this.choose(connection.url);
    if (!this.suspended) host.client.connect();
    this.emit();
  }
  choose(url: string) {
    if (!this.entries.has(url)) throw new Error("Computer not saved");
    const changed = this.active !== url;
    this.active = url;
    if (changed) { this.viewed = undefined; this.onSelect(url); }
    this.emit();
  }
  remove(url: string) {
    this.entries.get(url)?.client.disconnect(); this.entries.delete(url);
    if (this.active === url) { this.active = this.entries.keys().next().value; this.viewed = undefined; if (this.active) this.onSelect(this.active); }
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
  disconnect() { this.suspended = true; for (const host of this.entries.values()) { host.online = false; host.client.disconnect(); } }
  reconnect() { this.suspended = false; for (const host of this.entries.values()) { host.online = false; host.client.reconnect(); } this.emit(); }
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
    const result = await host.client.request(routed, body === undefined ? data : body, timeout);
    if (this.entries.get(host.connection.url) !== host) throw new Error("Computer was removed or reconfigured while the request was in flight. Check its native terminal before retrying.");
    if (route?.[3] === "history") return { ...result, session: { ...result.session, key: scopedKey(host.connection.url, result.session.key), source: this.source(host) } };
    if (result?.session && result?.main) host.state = result;
    if (switchHost) {
      if (!result?.session || !result?.main) host.state = await host.client.request("/api/state");
      this.choose(host.connection.url);
    }
    this.emit();
    return switchHost || route?.[3] === "monitor" ? this.snapshot() : result;
  }
}
