import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { CockpitStore } from "../../../packages/cockpit-state/store.js";
import { G2Presence } from "./g2-presence.js";

export interface Completion {
  id: number;
  at: number;
  sessionId?: string;
  sessionKey?: string;
  /** Persist the decision: leaving G2 later must not replay a notification already seen there. */
  viewedOnG2?: boolean;
  /** Chosen when the event occurs, so changing routes cannot replay old events. */
  forwardTo?: string;
  relayedFrom?: string;
  session: string;
  outcome: "completed" | "failed" | "interrupted";
}
interface Journal {
  nextId: number;
  events: Completion[];
  watchers: Record<string, number>;
  relayCursors?: Record<string, number>;
}
export class NotificationJournal {
  readonly g2 = new G2Presence();
  forwardingTarget: () => string | undefined = () => undefined;
  private data: Journal = { nextId: 1, events: [], watchers: {} };
  private persistedEvents: Completion[] = [];
  private listeners = new Set<(event: Completion) => void>();
  private unsubscribe: () => void;
  private pending: Completion[] = [];
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    store: CockpitStore,
    private path?: string,
  ) {
    if (path && existsSync(path)) {
      this.data = JSON.parse(readFileSync(path, "utf8")) as Journal;
      if (
        !Number.isSafeInteger(this.data.nextId) ||
        !Array.isArray(this.data.events) ||
        !this.data.watchers
      )
        throw new Error(
          "Invalid notification journal; move it aside before starting",
        );
    }
    this.persistedEvents = [...this.data.events];
    this.unsubscribe = store.subscribe((_state, event) => {
      if (event.type === "monitoring.settled") {
        const completion: Completion = {
          id: this.data.nextId++,
          at: Date.now(),
          sessionId: event.sessionId,
          sessionKey: event.sessionKey,
          viewedOnG2: this.g2.viewing(event.sessionKey) || undefined,
          forwardTo: this.forwardingTarget(),
          session: event.session,
          outcome: event.outcome,
        };
        this.data.events = [...this.data.events, completion].slice(-100);
        this.pending = [...this.pending, completion].slice(-100);
        this.flushPending();
      }
    });
  }
  private persist() {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path + ".tmp", JSON.stringify(this.data), {
        mode: 0o600,
      });
      renameSync(this.path + ".tmp", this.path);
    }
    // Every delivery reader uses this committed snapshot. A scheduled push or
    // relay pump must not see events whose save is still being retried.
    this.persistedEvents = [...this.data.events];
  }
  private flushPending() {
    if (this.closed || !this.pending.length) return;
    try { this.persist(); }
    catch {
      if (!this.retry) {
        this.retry = setTimeout(() => { this.retry = undefined; this.flushPending(); }, 1000);
        this.retry.unref();
      }
      return;
    }
    clearTimeout(this.retry); this.retry = undefined;
    const retained = new Set(this.data.events.map(event => event.id));
    const events = this.pending.filter(event => retained.has(event.id)); this.pending = [];
    for (const event of events) for (const listener of this.listeners) {
      try { listener(event); } catch { /* The durable journal remains available for receiver recovery. */ }
    }
  }
  list(after = 0) {
    return this.persistedEvents.filter((e) => e.id > after);
  }
  subscribe(listener: (event: Completion) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  receiveRelay(sourceId: string, sourceName: string, event: Completion) {
    const cursors = this.data.relayCursors || {};
    if (event.id <= (cursors[sourceId] || 0)) return false;
    const previous = this.data;
    const completion: Completion = { id: previous.nextId, at: Date.now(), sessionId: event.sessionId,
      session: `${sourceName} · ${event.session}`, outcome: event.outcome, relayedFrom: sourceId };
    this.data = { ...previous, nextId: previous.nextId + 1, relayCursors: { ...cursors, [sourceId]: event.id },
      events: [...previous.events, completion].slice(-100) };
    try { this.persist(); } catch (error) { this.data = previous; throw error; }
    for (const listener of this.listeners) listener(completion);
    return true;
  }
  close() {
    this.closed = true; clearTimeout(this.retry);
    this.unsubscribe();
  }
  poll(
    watcher: string,
    maxLength: number,
    titleMaxLength: number,
  ): { title: string; text: string } | undefined {
    const existed = Object.hasOwn(this.data.watchers, watcher);
    const cursor = existed
      ? this.data.watchers[watcher]
      : 0;
    const remaining = this.persistedEvents.filter(e => e.id > cursor);
    if (!remaining.length) return;
    const event = remaining.find(e => !e.viewedOnG2 && !e.forwardTo);
    if (
      !Object.hasOwn(this.data.watchers, watcher) &&
      Object.keys(this.data.watchers).length >= 100
    )
      throw new Error("Notification watcher limit reached");
    Object.defineProperty(this.data.watchers, watcher, {
      value: event?.id ?? remaining.at(-1)!.id,
      writable: true, enumerable: true, configurable: true,
    });
    try { this.persist(); }
    catch (error) {
      if (existed) Object.defineProperty(this.data.watchers, watcher, {
        value: cursor, writable: true, enumerable: true, configurable: true,
      });
      else delete this.data.watchers[watcher];
      throw error;
    }
    if (!event) return;
    const title = fit("Even-Pilot", titleMaxLength);
    const status =
      event.outcome === "completed"
        ? "Job complete"
        : event.outcome === "failed"
          ? "Job failed"
          : "Job interrupted";
    // Write the outcome first, so even a very short requested limit retains useful meaning.
    const text = fit(`${status} · ${event.session}`, maxLength);
    return { title, text };
  }
}
/** Android/Kotlin String.length counts UTF-16 units; do not split a surrogate pair. */
function fit(text: string, limit: number) {
  if (text.length <= limit) return text;
  if (limit === 1) return text[0];
  let result = text.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result + "…";
}
