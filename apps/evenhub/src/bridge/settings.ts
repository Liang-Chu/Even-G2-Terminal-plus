import type { Connection } from "./client.js";

const KEY = "even-pilot.connection.v1";
const LEGACY_KEY = "even-pilot.connection";
interface Saved { version: 1; updatedAt: number; connection: Connection | null; connections?: Connection[] }
interface AppStorage { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<boolean> }
type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function connection(value: unknown): Connection | undefined {
  if (!value || typeof value !== "object") return;
  const { url, token } = value as Connection;
  if (typeof url !== "string" || typeof token !== "string" || token.length < 24 || token.length > 512 || /[\r\n]/.test(token)) return;
  try {
    const origin = new URL(url);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return;
    return { url: origin.origin, token };
  } catch { return; }
}
function saved(raw: string | null): Saved | undefined {
  try {
    const value = JSON.parse(raw || "null");
    if (value?.version !== 1 || !Number.isFinite(value.updatedAt)) return;
    const next = connection(value.connection);
    const list = value.connections === undefined ? (next ? [next] : []) : Array.isArray(value.connections) ? value.connections.map(connection) : undefined;
    if (!list || list.length > 16 || list.some((item: Connection | undefined) => !item) || new Set(list.map((item: Connection) => item.url)).size !== list.length) return;
    if (value.connection === null || next) return { version: 1, updatedAt: value.updatedAt, connection: next || null, connections: list };
  } catch {}
}

/** Hub storage survives WebView recreation; browser storage is the fallback. */
export class ConnectionSettings {
  private record?: Saved;
  private bridge?: AppStorage;
  private revision = 0;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private local: () => WebStorage, private session: () => WebStorage) {
    try { this.record = saved(local().getItem(KEY)); } catch {}
    if (!this.record) try {
      const previous = connection(JSON.parse(session().getItem(LEGACY_KEY) || "null"));
      if (previous) this.record = { version: 1, updatedAt: 1, connection: previous };
    } catch {}
  }
  current() { return this.record?.connection || undefined; }
  all(): Connection[] { return [...(this.record?.connections || (this.current() ? [this.current()!] : []))]; }
  async attachBridge(bridge: AppStorage): Promise<Connection | undefined> {
    this.bridge = bridge;
    const revision = this.revision;
    try {
      const remote = saved(await bridge.getLocalStorage(KEY));
      // A late read must never replace a manually saved or forgotten connection.
      if (revision !== this.revision) return this.current();
      if (remote && (!this.record || remote.updatedAt >= this.record.updatedAt)) this.record = remote;
    } catch {}
    if (revision === this.revision && this.record) await this.persist(this.record);
    return this.current();
  }
  async save(value: Connection): Promise<boolean> {
    const next = connection(value);
    if (!next) throw new Error("Invalid saved connection");
    const list = this.all().filter(item => item.url !== next.url); list.push(next);
    if (list.length > 16) throw new Error("Up to 16 computers can be saved. Remove one first.");
    return this.replace(next, list);
  }
  async select(url: string) { const next = this.all().find(item => item.url === url); return next ? this.replace(next, this.all()) : false; }
  async remove(url: string) {
    const list = this.all().filter(item => item.url !== url);
    return this.replace(this.current()?.url === url ? list[0] || null : this.current() || null, list);
  }
  async clear(): Promise<boolean> { return this.replace(null, []); }
  private replace(value: Connection | null, connections: Connection[]) {
    this.revision++;
    this.record = { version: 1, updatedAt: Math.max(Date.now(), (this.record?.updatedAt || 0) + 1), connection: value, connections };
    return this.persist(this.record);
  }
  private persist(record: Saved): Promise<boolean> {
    const raw = JSON.stringify(record);
    let fallback = false;
    try { this.local().setItem(KEY, raw); fallback = true; } catch {}
    try { this.session().removeItem(LEGACY_KEY); } catch {}
    const write = async () => {
      if (!this.bridge) return fallback;
      try {
        if (await this.bridge.setLocalStorage(KEY, raw)) {
          // Keep only one durable copy once the native app acknowledges it.
          if (this.record === record) try { this.local().removeItem(KEY); } catch {}
          return true;
        }
      } catch {}
      return fallback;
    };
    const pending = this.writes.then(write, write);
    this.writes = pending;
    return pending;
  }
}
