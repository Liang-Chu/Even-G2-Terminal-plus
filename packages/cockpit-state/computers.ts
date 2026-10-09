/** Shared connection records. Only paired clients with the control key may read them. */
export interface ComputerStamp { counter: number; writer: string }
export type ComputerEntry =
  | { id: string; url: string; token: string; name?: string; stamp: ComputerStamp; deleted?: false }
  | { id: string; stamp: ComputerStamp; deleted: true };
export interface ComputerBook { version: 1; entries: ComputerEntry[] }

const identity = /^[a-zA-Z0-9_-]{1,128}$/;
const maximumCounter = Number.MAX_SAFE_INTEGER - 1;
const invalid = () => new Error("Invalid saved computer data");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Origins are portable between devices; localhost belongs only to the current page. */
export function computerOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash) throw invalid();
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
    host === "0.0.0.0" || host.startsWith("127.") || host === "::" || host === "::1" ||
    /^::(?:ffff:)?(?:7f[0-9a-f]{2}:|0:0$)/.test(host)) throw invalid();
  return url.origin;
}

export function parseComputerBook(value: unknown): ComputerBook {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 128) throw invalid();
  const ids = new Set<string>();
  let live = 0;
  const entries = value.entries.map((item): ComputerEntry => {
    if (!object(item) || typeof item.id !== "string" || !identity.test(item.id) || ids.has(item.id) ||
      !object(item.stamp) || !Number.isSafeInteger(item.stamp.counter) || Number(item.stamp.counter) < 0 ||
      Number(item.stamp.counter) > maximumCounter || typeof item.stamp.writer !== "string" || !identity.test(item.stamp.writer)) throw invalid();
    ids.add(item.id);
    const stamp = { counter: Number(item.stamp.counter), writer: item.stamp.writer };
    if (item.deleted === true) return { id: item.id, stamp, deleted: true };
    if (item.deleted !== undefined && item.deleted !== false || ++live > 16 ||
      typeof item.token !== "string" || item.token.length < 24 || item.token.length > 512 || /[\x00-\x20\x7f]/.test(item.token) ||
      item.name !== undefined && (typeof item.name !== "string" || !item.name.trim() || item.name.length > 128 || /[\x00-\x1f\x7f]/.test(item.name))) throw invalid();
    return { id: item.id, url: computerOrigin(item.url), token: item.token,
      ...(typeof item.name === "string" ? { name: item.name.trim() } : {}), stamp };
  });
  return { version: 1, entries: entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

function compare(a: ComputerEntry, b: ComputerEntry): number {
  const counters = a.stamp.counter - b.stamp.counter;
  if (counters) return counters;
  if (a.stamp.writer !== b.stamp.writer) return a.stamp.writer < b.stamp.writer ? -1 : 1;
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return a.deleted ? 1 : -1;
  // A malformed writer reusing a stamp must still converge in every merge order.
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function mergeComputerBooks(...books: ComputerBook[]): ComputerBook {
  const entries = new Map<string, ComputerEntry>();
  for (const book of books) for (const entry of parseComputerBook(book).entries) {
    const existing = entries.get(entry.id);
    if (!existing || compare(entry, existing) > 0) entries.set(entry.id, entry);
  }
  return parseComputerBook({ version: 1, entries: [...entries.values()] });
}

export function nextComputerStamp(book: ComputerBook, writer: string): ComputerStamp {
  if (typeof writer !== "string" || !identity.test(writer)) throw invalid();
  const maximum = parseComputerBook(book).entries.reduce((counter, entry) => Math.max(counter, entry.stamp.counter), 0);
  if (maximum >= maximumCounter) throw invalid();
  return { counter: maximum + 1, writer };
}
