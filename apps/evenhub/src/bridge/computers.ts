import { computerOrigin, mergeComputerBooks, nextComputerStamp, parseComputerBook,
  type ComputerBook } from "../../../../packages/cockpit-state/computers.js";
import type { Connection } from "./client.js";
import type { FleetClient } from "./fleet.js";
import type { ConnectionSettings } from "./settings.js";

interface Alias { id: string; url: string }
interface Owner { id: string; name: string; url?: string }
interface Shared { book: ComputerBook; owner: Owner }
const empty = (): ComputerBook => ({ version: 1, entries: [] });
const signature = (book: ComputerBook) => JSON.stringify(book);
const identity = /^[a-zA-Z0-9_-]{1,128}$/;
const portable = (url: string) => { try { return computerOrigin(url); } catch { return undefined; } };
function shared(value: unknown): Shared {
  const result = value as Partial<Shared>;
  if (!result?.owner || typeof result.owner.id !== "string" || !identity.test(result.owner.id) ||
    typeof result.owner.name !== "string" || !result.owner.name.trim() || result.owner.name.length > 128 ||
    /[\x00-\x1f\x7f]/.test(result.owner.name)) throw new Error("Invalid shared computer data");
  return { book: parseComputerBook(value), owner: { id: result.owner.id, name: result.owner.name,
    ...(result.owner.url === undefined ? {} : { url: computerOrigin(result.owner.url) }) } };
}

/** Shares connection metadata only. Session transports and their retry budgets stay independent. */
export class ComputerSync {
  private book: ComputerBook;
  private aliases = new Map<string, string>();
  private owners = new Map<string, Owner>();
  private capable = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private started = false;
  private suspended = false;
  private closed = false;
  private generation = 0;
  private dirty = false;
  private warned = false;
  private notifiedHosts = "";
  private canonical = new Map<string, string>();
  private lastSaved = false;
  private writer = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  constructor(private getFleet: () => FleetClient | undefined, private settings: ConnectionSettings,
    private options: { servingOrigin?: string; onError?: (message: string) => void } = {}) {
    this.book = settings.computerBook() || empty();
    for (const entry of this.book.entries) if (!entry.deleted) this.canonical.set(entry.id, entry.url);
    for (const alias of settings.computerAliases()) this.aliases.set(alias.url, alias.id);
  }
  start() {
    if (this.closed || this.started) return;
    this.started = true;
    this.notifiedHosts = this.hostSignature();
    this.timer = setInterval(() => { if (this.available()) void this.refresh(); }, 15_000);
    this.timer.unref?.();
    void this.refresh();
  }
  notify() {
    if (!this.started || !this.available()) return;
    const hosts = this.hostSignature();
    if (hosts === this.notifiedHosts) return;
    this.notifiedHosts = hosts;
    if (this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.refresh(); }, 150);
    this.debounce.unref?.();
  }
  suspend() { this.suspended = true; this.generation++; clearTimeout(this.debounce); this.debounce = undefined; }
  resume() { if (this.closed) return; this.suspended = false; this.notifiedHosts = ""; this.start(); this.notify(); }
  close() { this.closed = true; this.suspend(); clearInterval(this.timer); }
  private available() { return !this.closed && !this.suspended && (typeof document === "undefined" || !document.hidden); }
  private hostSignature() {
    const fleet = this.getFleet();
    return JSON.stringify([fleet?.hosts().map(host => [host.id, host.url, host.online]).sort(),
      fleet?.connections().map(connection => [connection.url, connection.token]).sort()]);
  }
  private current(fleet: FleetClient, epoch: number, connection?: Connection) {
    return this.available() && this.generation === epoch && fleet === this.getFleet() &&
      (!connection || fleet.connections().some(next => next.url === connection.url && next.token === connection.token));
  }
  private verifiedId(fleet: FleetClient, url: string) {
    const host = fleet.hosts().find(host => host.url === url);
    return host && host.nameSource !== "address" && identity.test(host.id) ? host.id : undefined;
  }
  private knownId(fleet: FleetClient, url: string) { return this.aliases.get(url) || this.verifiedId(fleet, url); }
  private absorb(book: ComputerBook) { this.book = mergeComputerBooks(this.book, book); }
  private absorbSettings() {
    this.absorb(this.settings.computerBook() || empty());
    for (const alias of this.settings.computerAliases()) if (!this.aliases.has(alias.url)) this.aliases.set(alias.url, alias.id);
  }
  private remember(owner: Owner, url: string) {
    this.owners.set(url, owner); this.aliases.set(url, owner.id);
    if (owner.url) this.aliases.set(owner.url, owner.id);
  }
  private async read(fleet: FleetClient, connection: Connection, epoch: number, explicit = false) {
    // Each write cycle requires a fresh, validated directory response. A changed
    // or unsupported endpoint must not receive other computers' credentials.
    this.capable.delete(connection.url);
    const value = shared(await fleet.requestFrom(connection.url, "/api/computers", undefined, 5000));
    if (!this.current(fleet, epoch, connection) || !fleet.hosts().some(host => host.url === connection.url && host.online)) return;
    const known = explicit ? this.verifiedId(fleet, connection.url) : this.knownId(fleet, connection.url);
    if (known && known !== value.owner.id) { this.owners.delete(connection.url); throw new Error("Computer identity changed"); }
    this.absorbSettings();
    this.remember(value.owner, connection.url); this.capable.set(connection.url, signature(value.book)); this.absorb(value.book);
    return value;
  }
  /** A verified, deliberate Connect may repair a key or restore a removed computer. */
  async connected(connection: Connection): Promise<boolean> {
    this.lastSaved = false;
    const epoch = ++this.generation;
    await this.flight;
    const fleet = this.getFleet();
    if (!fleet || !this.current(fleet, epoch, connection)) return false;
    const priorIdentity = this.aliases.get(connection.url);
    try { await this.read(fleet, connection, epoch, true); } catch { /* Older companions keep their local connection. */ }
    if (!this.current(fleet, epoch, connection)) return false;
    this.absorbSettings();
    const id = this.verifiedId(fleet, connection.url) || this.knownId(fleet, connection.url), owner = this.owners.get(connection.url);
    const url = portable(connection.url) || owner?.url;
    if (!id || !url) return false;
    for (const existing of this.book.entries.filter(entry => !entry.deleted && entry.id !== id &&
      (entry.id === priorIdentity || entry.url === url || entry.url === owner?.url)))
      this.absorb({ version: 1, entries: [{ id: existing.id, deleted: true, stamp: nextComputerStamp(this.book, this.writer) }] });
    const name = owner?.name || fleet.hosts().find(host => host.url === connection.url)?.name;
    this.absorb({ version: 1, entries: [{ id, url, token: connection.token, ...(name ? { name } : {}),
      stamp: nextComputerStamp(this.book, this.writer) }] });
    this.aliases.set(connection.url, id); this.aliases.set(url, id);
    await this.refresh();
    return this.current(fleet, epoch) && this.lastSaved;
  }
  /** Removal is durable metadata; it never changes Watch or a native terminal. */
  async remove(url: string): Promise<boolean> {
    this.lastSaved = false;
    const epoch = ++this.generation;
    await this.flight;
    const fleet = this.getFleet();
    if (!fleet || !this.current(fleet, epoch)) return false;
    this.absorbSettings();
    const id = this.knownId(fleet, url);
    if (!id) return false;
    this.absorb({ version: 1, entries: [{ id, deleted: true, stamp: nextComputerStamp(this.book, this.writer) }] });
    await this.refresh();
    return this.current(fleet, epoch) && this.lastSaved;
  }
  async refresh(): Promise<void> {
    if (!this.available()) return;
    if (this.flight) { this.dirty = true; return this.flight; }
    this.flight = (async () => {
      do {
        this.dirty = false;
        const fleet = this.getFleet(), epoch = this.generation;
        if (!fleet || !this.current(fleet, epoch)) return;
        try { await this.synchronize(fleet, epoch); this.warned = false; }
        catch { if (this.current(fleet, epoch) && !this.warned) {
          this.warned = true; this.options.onError?.("Shared computer connections could not be updated. Saved connections were retained.");
        } }
      } while (this.dirty && this.available());
    })().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async synchronize(fleet: FleetClient, epoch: number) {
    this.absorbSettings();
    const connections = fleet.connections();
    await Promise.all(connections.map(async connection => {
      if (!fleet.hosts().some(host => host.url === connection.url && host.online)) return;
      try { await this.read(fleet, connection, epoch); } catch { /* Preserve cached metadata through outages and old backends. */ }
    }));
    if (!this.current(fleet, epoch)) return;
    this.absorbSettings();
    // Import only a verified legacy computer that has never had a shared record.
    // A tombstone is a record too, and always defeats automatic cache migration.
    for (const connection of fleet.connections()) {
      const host = fleet.hosts().find(host => host.url === connection.url);
      const id = host?.online ? this.knownId(fleet, connection.url) : undefined;
      if (!id) continue;
      if (this.verifiedId(fleet, connection.url) && this.verifiedId(fleet, connection.url) !== id) continue;
      this.aliases.set(connection.url, id);
      if (this.book.entries.some(entry => entry.id === id)) continue;
      const url = portable(connection.url) || this.owners.get(connection.url)?.url;
      if (url) this.absorb({ version: 1, entries: [{ id, url, token: connection.token, name: host!.name,
        stamp: nextComputerStamp(this.book, this.writer) }] });
    }
    // Propagate tombstones before disconnecting removed transports; returned
    // merges may contain a concurrent edit and must be retained, not overwritten.
    for (let round = 0; round < 3 && this.current(fleet, epoch); round++) {
      this.absorbSettings();
      let changed = false;
      const snapshot = this.book, sent = signature(snapshot);
      await Promise.all(fleet.connections().map(async connection => {
        if (!this.capable.has(connection.url) || this.capable.get(connection.url) === sent ||
          !fleet.hosts().some(host => host.url === connection.url && host.online)) return;
        try {
          const value = shared(await fleet.requestFrom(connection.url, "/api/computers", snapshot, 5000));
          if (!this.current(fleet, epoch, connection)) return;
          if (this.knownId(fleet, connection.url) !== value.owner.id) return;
          this.remember(value.owner, connection.url); this.capable.set(connection.url, signature(value.book));
          const before = signature(this.book); this.absorb(value.book); changed ||= signature(this.book) !== before;
        } catch { /* Cached edits remain available for the next successful synchronization. */ }
      }));
      const beforeCache = signature(this.book); this.absorbSettings(); changed ||= beforeCache !== signature(this.book);
      if (!changed) break;
    }
    if (this.current(fleet, epoch)) await this.apply(fleet, epoch);
  }
  private async apply(fleet: FleetClient, epoch: number) {
    this.absorbSettings();
    const existing = fleet.connections(), desired: Connection[] = [], ids = new Set<string>(), urls = new Set<string>();
    const active = fleet.activeUrl() || this.settings.current()?.url;
    const add = (connection: Connection, id?: string) => {
      if (urls.has(connection.url) || id && ids.has(id)) return;
      desired.push(connection); urls.add(connection.url); if (id) ids.add(id);
    };
    for (const entry of this.book.entries) if (!entry.deleted) {
      this.aliases.set(entry.url, entry.id);
      const matches = existing.filter(connection => this.knownId(fleet, connection.url) === entry.id);
      const transport = matches.find(connection => connection.url === this.options.servingOrigin) ||
        matches.find(connection => connection.url === active) || matches[0];
      const changed = this.canonical.has(entry.id) && this.canonical.get(entry.id) !== entry.url;
      const url = transport && transport.url === this.options.servingOrigin ? transport.url : changed ? entry.url : transport?.url || entry.url;
      add({ url, token: entry.token }, entry.id);
    }
    for (const connection of existing) {
      const id = this.knownId(fleet, connection.url), entry = this.book.entries.find(entry => entry.id === id);
      if (!id || !entry || entry.deleted && connection.url === this.options.servingOrigin) add(connection, id);
    }
    const aliases: Alias[] = [...this.aliases].map(([url, id]) => ({ id, url }));
    const beforeCache = signature(this.book);
    const cacheSaved = await this.settings.saveComputerCache(this.book, aliases);
    if (!this.current(fleet, epoch)) return;
    this.absorbSettings();
    if (signature(this.book) !== beforeCache) { this.dirty = true; return; }
    const selected = fleet.activeUrl() || active, selectedId = selected ? this.knownId(fleet, selected) : undefined;
    const nextActive = desired.find(connection => connection.url === selected)?.url ||
      desired.find(connection => this.aliases.get(connection.url) === selectedId)?.url || desired[0]?.url;
    const connectionsSaved = await this.settings.replaceConnections(desired, nextActive);
    if (!this.current(fleet, epoch)) return;
    this.absorbSettings();
    if (signature(this.book) !== beforeCache) { this.dirty = true; return; }
    const savedBook = signature(this.book);
    const backendSaved = fleet.connections().some(connection => this.capable.get(connection.url) === savedBook &&
      fleet.hosts().some(host => host.url === connection.url && host.online));
    this.lastSaved = cacheSaved && connectionsSaved || backendSaved;
    if (!this.lastSaved) throw new Error("Computer changes could not be saved");
    for (const connection of existing) if (!desired.some(next => next.url === connection.url)) fleet.remove(connection.url);
    for (const connection of desired) {
      if (!this.current(fleet, epoch)) return;
      if (!fleet.connections().some(next => next.url === connection.url && next.token === connection.token)) {
        await fleet.add(connection, true, false, () => this.current(fleet, epoch));
        this.dirty = true;
      }
    }
    if (nextActive && fleet.activeUrl() !== nextActive) fleet.choose(nextActive);
    for (const entry of this.book.entries) if (!entry.deleted) this.canonical.set(entry.id, entry.url);
  }
}
