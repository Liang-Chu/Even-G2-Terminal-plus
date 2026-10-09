import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { computerOrigin, mergeComputerBooks, nextComputerStamp, parseComputerBook,
  type ComputerBook, type ComputerEntry } from "../../../packages/cockpit-state/computers.js";

export interface ComputerOwner { id: string; name: string; url?: string; token: string }
export interface ComputerSnapshot extends ComputerBook { owner: { id: string; name: string; url?: string } }
export class ComputerDirectoryError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

/** Atomic private connection storage, independent of session monitoring and notification routing. */
export class ComputerDirectory {
  private book: ComputerBook = { version: 1, entries: [] };
  private serial: Promise<void> = Promise.resolve();
  constructor(private path: string, private owner: () => ComputerOwner | Promise<ComputerOwner>) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new Error();
      this.book = parseComputerBook(JSON.parse(readFileSync(path, "utf8")));
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ComputerDirectoryError("Saved computer storage is unavailable; restore it before reconnecting", 503);
    }
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }
  private persist(book: ComputerBook) {
    const normalized = parseComputerBook(book);
    if (JSON.stringify(normalized) === JSON.stringify(this.book)) return;
    const temporary = this.path + "." + randomUUID() + ".tmp";
    let descriptor: number | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(normalized)); fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, this.path);
      this.book = normalized;
    } catch {
      throw new ComputerDirectoryError("Saved computer storage is unavailable; changes were not saved", 503);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* A successful rename already removed the temporary file. */ }
    }
  }
  private async identity() {
    let current: ComputerOwner;
    try {
      current = await this.owner();
      // Reuse the protocol validator without allowing localhost into shared storage.
      parseComputerBook({ version: 1, entries: [{ ...current, url: "http://100.64.0.1:4317", stamp: { counter: 0, writer: current.id } }] });
    } catch { throw new ComputerDirectoryError("Computer identity is unavailable", 503); }
    let url: string | undefined;
    if (current.url) try { url = computerOrigin(current.url); } catch { /* A local-only backend has no portable connection address. */ }
    return { ...current, name: current.name.trim(), url };
  }
  private refresh(book: ComputerBook, owner: ComputerOwner): ComputerBook {
    const existing = book.entries.find(entry => entry.id === owner.id);
    if (existing?.deleted) return book;
    const url = existing && existing.stamp.counter > 0 ? existing.url : owner.url || existing?.url;
    if (!url) return book;
    const entry: ComputerEntry = { id: owner.id, name: owner.name, url, token: owner.token,
      stamp: existing ? existing.stamp : { counter: 0, writer: owner.id } };
    if (existing && existing.url === entry.url && existing.token === entry.token && existing.name === entry.name) return book;
    if (existing) entry.stamp = nextComputerStamp(book, owner.id);
    return parseComputerBook({ version: 1, entries: [...book.entries.filter(item => item.id !== owner.id), entry] });
  }
  private response(owner: ComputerOwner): ComputerSnapshot {
    return { ...parseComputerBook(this.book), owner: { id: owner.id, name: owner.name, ...(owner.url ? { url: owner.url } : {}) } };
  }
  snapshot(): Promise<ComputerSnapshot> {
    return this.queue(async () => {
      const owner = await this.identity();
      this.persist(this.refresh(this.book, owner));
      return this.response(owner);
    });
  }
  merge(payload: unknown): Promise<ComputerSnapshot> {
    let incoming: ComputerBook;
    try { incoming = parseComputerBook(payload); }
    catch { return Promise.reject(new ComputerDirectoryError("Invalid saved computer data")); }
    return this.queue(async () => {
      const owner = await this.identity();
      const current = this.refresh(this.book, owner);
      let merged: ComputerBook;
      try {
        merged = mergeComputerBooks(current, incoming);
        const own = merged.entries.find(entry => entry.id === owner.id);
        if (own && !own.deleted) {
          const previous = current.entries.find(entry => entry.id === owner.id);
          const actualUrl = own.token === owner.token ? own.url
            : previous && !previous.deleted ? previous.url : owner.url;
          if (!actualUrl) throw new Error();
          // A user-chosen gateway with the right key is valid. A wrong-key
          // replica cannot replace the current address or real control key.
          merged = this.refresh({ ...merged, entries: merged.entries.map(entry => entry.id === owner.id && !entry.deleted
            ? { ...entry, url: actualUrl } : entry) }, { ...owner, url: actualUrl });
        }
      } catch { throw new ComputerDirectoryError("Invalid saved computer data"); }
      this.persist(merged);
      return this.response(owner);
    });
  }
}
