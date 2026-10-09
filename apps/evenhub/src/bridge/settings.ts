import type { Connection } from "./client.js";
import { mergeComputerBooks, parseComputerBook, type ComputerBook } from "../../../../packages/cockpit-state/computers.js";

const KEY = "even-pilot.connection.v1";
const LEGACY_KEY = "even-pilot.connection";
export interface ComputerAlias { id: string; url: string }
interface Saved { version: 1; updatedAt: number; connection: Connection | null; connections?: Connection[];
  computerBook?: ComputerBook; computerAliases?: ComputerAlias[] }
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
    let computerBook: ComputerBook | undefined;
    if (value.computerBook !== undefined) try { computerBook = parseComputerBook(value.computerBook); } catch { /* Retain valid bootstrap connections. */ }
    const computerAliases = aliases(value.computerAliases);
    if (value.connection === null || next) return { version: 1, updatedAt: value.updatedAt, connection: next || null, connections: list,
      ...(computerBook ? { computerBook } : {}), ...(computerAliases ? { computerAliases } : {}) };
  } catch {}
}
function aliases(value: unknown): ComputerAlias[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return;
  const result: ComputerAlias[] = [], seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) || typeof item.url !== "string") return;
    const checked = connection({ url: item.url, token: "synthetic-alias-validation-key" });
    if (!checked || seen.has(checked.url)) return;
    seen.add(checked.url); result.push({ id: item.id, url: checked.url });
  }
  return result;
}

/** Hub storage survives WebView recreation; browser storage is the fallback. */
export class ConnectionSettings {
  private record?: Saved;
  private persisted?: Saved;
  private bridge?: AppStorage;
  private revision = 0;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private local: () => WebStorage, private session: () => WebStorage) {
    try { this.record = saved(local().getItem(KEY)); this.persisted = this.record; } catch {}
    if (!this.record) try {
      const previous = connection(JSON.parse(session().getItem(LEGACY_KEY) || "null"));
      if (previous) this.record = { version: 1, updatedAt: 1, connection: previous };
    } catch {}
  }
  current() { return this.record?.connection || undefined; }
  all(): Connection[] { return [...(this.record?.connections || (this.current() ? [this.current()!] : []))]; }
  computerBook(): ComputerBook { return parseComputerBook(this.record?.computerBook || { version: 1, entries: [] }); }
  computerAliases(): ComputerAlias[] { return (this.record?.computerAliases || []).map(item => ({ ...item })); }
  async saveComputerCache(book: ComputerBook, values: ComputerAlias[]): Promise<boolean> {
    // A late synchronization result cannot replace a newer native removal.
    const checkedBook = mergeComputerBooks(this.computerBook(), parseComputerBook(book)), checkedAliases = aliases(values);
    if (!checkedAliases) throw new Error("Invalid saved computer aliases");
    if (JSON.stringify(checkedBook) === JSON.stringify(this.record?.computerBook) &&
      JSON.stringify(checkedAliases) === JSON.stringify(this.record?.computerAliases))
      return this.record && this.persisted !== this.record ? this.persist(this.record) : true;
    this.revision++;
    this.record = { ...this.record, version: 1, updatedAt: Math.max(Date.now(), (this.record?.updatedAt || 0) + 1),
      connection: this.current() || null, connections: this.all(), computerBook: checkedBook, computerAliases: checkedAliases };
    return this.persist(this.record);
  }
  async replaceConnections(values: Connection[], activeUrl = this.current()?.url): Promise<boolean> {
    const list = values.map(connection);
    if (list.length > 16 || list.some(item => !item) || new Set(list.map(item => item!.url)).size !== list.length)
      throw new Error("Invalid saved computer connections");
    const checked = list as Connection[], selected = checked.find(item => item.url === activeUrl) || checked[0] || null;
    if (JSON.stringify(checked) === JSON.stringify(this.all()) && JSON.stringify(selected) === JSON.stringify(this.current() || null))
      return this.record && this.persisted !== this.record ? this.persist(this.record) : true;
    return this.replace(selected, checked);
  }
  async attachBridge(bridge: AppStorage): Promise<Connection | undefined> {
    this.bridge = bridge;
    const revision = this.revision;
    try {
      const remote = saved(await bridge.getLocalStorage(KEY));
      // Connection selection uses its local timestamp, but shared removals use
      // logical versions and must survive a later local selection or save.
      const book = mergeComputerBooks(this.computerBook(), remote?.computerBook || { version: 1, entries: [] });
      const combinedAliases = new Map<string, ComputerAlias>();
      for (const item of remote?.computerAliases || []) combinedAliases.set(item.url, item);
      for (const item of this.computerAliases()) combinedAliases.set(item.url, item);
      if (revision === this.revision && remote && (!this.record || remote.updatedAt >= this.record.updatedAt)) this.record = remote;
      if (book.entries.length || combinedAliases.size) await this.saveComputerCache(book, [...combinedAliases.values()]);
    } catch { return this.current(); }
    if (this.record) await this.persist(this.record);
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
    this.record = { ...this.record, version: 1, updatedAt: Math.max(Date.now(), (this.record?.updatedAt || 0) + 1), connection: value, connections };
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
    const pending = this.writes.then(write, write).then(saved => { if (saved) this.persisted = record; return saved; });
    this.writes = pending;
    return pending;
  }
}
