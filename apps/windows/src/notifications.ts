import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { CockpitStore } from "../../../packages/cockpit-state/store.js";
import type { InputAttention } from "../../../packages/cockpit-state/types.js";
import { G2Presence } from "./g2-presence.js";

interface NotificationBase {
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
}
export interface Completion extends NotificationBase {
  kind?: "completion";
  outcome: "completed" | "failed" | "interrupted";
}
export interface AttentionNotification extends NotificationBase {
  kind: "attention";
  outcome?: never;
  attentionId: string;
  reason: InputAttention["kind"];
  expiresAt?: number;
}
export interface AttentionResolution extends NotificationBase {
  kind: "attention-resolved";
  outcome?: never;
  attentionId: string;
}
export type NotificationEvent = Completion | AttentionNotification | AttentionResolution;
interface AttentionRecord {
  sessionKey?: string; sessionId?: string; session: string; reason: InputAttention["kind"];
  at: number; eventId: number; active: boolean; expiresAt?: number; forwardTo?: string;
}
export const ATTENTION_FRESHNESS_MS = 30_000;
const attentionLimit = 2048;
const attentionIdPattern = /^(?:[a-f0-9-]{36}:)?[a-f0-9]{64}$/;
const attentionKinds = ["approval", "question", "terminal-input"];
function validAttentionRecord(value: any) {
  return value && typeof value.active === "boolean" && Number.isFinite(value.at) && value.at >= 0 &&
    Number.isSafeInteger(value.eventId) && value.eventId >= 0 &&
    typeof value.session === "string" && value.session.length <= 4096 && attentionKinds.includes(value.reason) &&
    (value.sessionKey === undefined || (typeof value.sessionKey === "string" && /^[a-f0-9]{32}$/.test(value.sessionKey))) &&
    (value.sessionId === undefined || (typeof value.sessionId === "string" && value.sessionId.length <= 256)) &&
    (value.expiresAt === undefined || (Number.isFinite(value.expiresAt) && value.expiresAt >= 0)) &&
    (value.forwardTo === undefined || (typeof value.forwardTo === "string" && /^[a-f0-9-]{36}$/.test(value.forwardTo)));
}
interface Journal {
  nextId: number;
  events: NotificationEvent[];
  watchers: Record<string, number>;
  relayCursors?: Record<string, number>;
  attention?: Record<string, AttentionRecord>;
}
export class NotificationJournal {
  readonly g2 = new G2Presence();
  forwardingTarget: () => string | undefined = () => undefined;
  private data: Journal = { nextId: 1, events: [], watchers: {} };
  private persistedEvents: NotificationEvent[] = [];
  private persistedAttention: Record<string, AttentionRecord> = {};
  private listeners = new Set<(event: NotificationEvent) => void>();
  private unsubscribe: () => void;
  private pending: NotificationEvent[] = [];
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private attentionDirty = false;
  constructor(
    store: CockpitStore,
    private path?: string,
  ) {
    if (path && existsSync(path)) {
      try { this.data = JSON.parse(readFileSync(path, "utf8")) as Journal; }
      catch { throw new Error("Invalid notification journal; move it aside before starting"); }
      if (
        !Number.isSafeInteger(this.data.nextId) ||
        !Array.isArray(this.data.events) ||
        !this.data.watchers || (this.data.attention !== undefined &&
          (!this.data.attention || typeof this.data.attention !== "object" || Array.isArray(this.data.attention) ||
            Object.keys(this.data.attention).length > attentionLimit ||
            Object.entries(this.data.attention).some(([id, value]) => !attentionIdPattern.test(id) || !validAttentionRecord(value))))
      )
        throw new Error(
          "Invalid notification journal; move it aside before starting",
        );
    }
    this.persistedEvents = [...this.data.events];
    this.persistedAttention = structuredClone(this.data.attention || {});
    this.unsubscribe = store.subscribe((_state, event) => {
      if (event.type === "monitoring.attention") {
        this.reconcileAttention(event.sessionKey, event.sessionId, event.session, event.requests);
      } else if (event.type === "monitoring.settled") {
        if (event.sessionKey && Object.values(this.data.attention || {}).some(record =>
          record.sessionKey === event.sessionKey && record.active && (record.expiresAt === undefined || record.expiresAt > Date.now()))) return;
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
    this.persistedAttention = structuredClone(this.data.attention || {});
    this.attentionDirty = false;
  }
  private retireAttention(records: Record<string, AttentionRecord>, now: number) {
    for (const record of Object.values(records)) if (record.active && record.expiresAt !== undefined && record.expiresAt <= now) {
      record.active = false; record.at = now; this.attentionDirty = true;
    }
    const closed = Object.entries(records).filter(([, record]) => !record.active).sort((a, b) => a[1].at - b[1].at);
    let count = Object.keys(records).length;
    for (const [id, record] of closed) if (record.at < now - 86_400_000 || count >= attentionLimit) {
      delete records[id]; count--; this.attentionDirty = true;
    }
  }
  private reconcileAttention(sessionKey: string, sessionId: string | undefined, session: string, requests: InputAttention[]) {
    if (!/^[a-f0-9]{32}$/.test(sessionKey) || !Array.isArray(requests) || requests.length > 16 ||
      requests.some(item => !item || !/^[a-f0-9]{64}$/.test(item.id) ||
        !["approval", "question", "terminal-input"].includes(item.kind) ||
        (item.createdAt !== undefined && (!Number.isFinite(item.createdAt) || item.createdAt < 0 || item.createdAt > Date.now() + 60_000)) ||
        (item.expiresAt !== undefined && (!Number.isFinite(item.expiresAt) || item.expiresAt < 0)) ||
        (item.baseline !== undefined && item.baseline !== true))) return;
    const now = Date.now(), current = new Map(requests.filter(item => item.expiresAt === undefined || item.expiresAt > now).map(item => [item.id, item]));
    const records = this.data.attention ||= {};
    const events: NotificationEvent[] = [];
    for (const [id, record] of Object.entries(records)) if (record.active && record.sessionKey === sessionKey && !current.has(id)) {
      record.active = false; record.at = now;
      events.push({ kind: "attention-resolved", attentionId: id, id: this.data.nextId++, at: now,
        sessionKey, sessionId: record.sessionId, session: record.session, forwardTo: record.forwardTo });
      this.attentionDirty = true;
    }
    // Closed identities remain for stale snapshot defense, while a long-lived
    // active prompt never depends on the bounded 100-event delivery history.
    this.retireAttention(records, now);
    for (const [id, request] of current) {
      if (records[id] || Object.keys(records).length >= attentionLimit) continue;
      if (request.baseline) {
        records[id] = { sessionKey, sessionId, session, reason: request.kind, at: now, eventId: 0,
          active: true, expiresAt: request.expiresAt };
        this.attentionDirty = true; continue;
      }
      const event: AttentionNotification = { kind: "attention", attentionId: id, reason: request.kind,
        id: this.data.nextId++, at: request.createdAt ?? now, sessionKey, sessionId, session, expiresAt: request.expiresAt,
        // A mounted conversation/voice page does not prove the user saw this
        // particular choice. Completion suppression remains separate below.
        forwardTo: this.forwardingTarget() };
      records[id] = { sessionKey, sessionId, session, reason: request.kind, at: now, eventId: event.id,
        active: true, expiresAt: request.expiresAt, forwardTo: event.forwardTo };
      this.attentionDirty = true;
      events.push(event);
    }
    this.data.events = [...this.data.events, ...events].slice(-100);
    this.pending = [...this.pending, ...events].slice(-100);
    this.flushPending();
  }
  attentionPending(id: string, now = Date.now()) {
    const record = this.persistedAttention[id];
    return !!record?.active && (record.expiresAt === undefined || record.expiresAt > now);
  }
  private flushPending() {
    if (this.closed || (!this.pending.length && !this.attentionDirty)) return;
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
  subscribe(listener: (event: NotificationEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  receiveRelay(sourceId: string, sourceName: string, event: NotificationEvent) {
    const cursors = this.data.relayCursors || {};
    if (event.id <= (cursors[sourceId] || 0)) return false;
    const previous = this.data;
    const base = { id: previous.nextId, at: event.kind === "attention" ? event.at : Date.now(), sessionId: event.sessionId,
      session: `${sourceName} · ${event.session}`, relayedFrom: sourceId };
    const attentionId = event.kind === "attention" || event.kind === "attention-resolved" ? sourceId + ":" + event.attentionId : undefined;
    const completion: NotificationEvent = event.kind === "attention" ? { ...base, kind: "attention", attentionId: attentionId!, reason: event.reason, expiresAt: event.expiresAt }
      : event.kind === "attention-resolved" ? { ...base, kind: "attention-resolved", attentionId: attentionId! }
      : { ...base, outcome: event.outcome };
    const records = structuredClone(previous.attention || {});
    this.retireAttention(records, Date.now());
    const duplicate = attentionId !== undefined && completion.kind === "attention" && !!records[attentionId];
    if (completion.kind === "attention" && !duplicate && Object.keys(records).length >= attentionLimit)
      throw new Error("Notification attention limit reached");
    if (completion.kind === "attention" && !duplicate) records[completion.attentionId] = { session: completion.session,
      reason: completion.reason, at: completion.at, eventId: completion.id, active: true, expiresAt: completion.expiresAt };
    else if (completion.kind === "attention-resolved") {
      if (!records[completion.attentionId] && Object.keys(records).length >= attentionLimit)
        throw new Error("Notification attention limit reached");
      records[completion.attentionId] = { ...(records[completion.attentionId] || { session: completion.session, reason: "terminal-input",
        eventId: completion.id }), at: Date.now(), active: false };
    }
    this.data = { ...previous, nextId: previous.nextId + (duplicate ? 0 : 1), relayCursors: { ...cursors, [sourceId]: event.id },
      events: duplicate ? previous.events : [...previous.events, completion].slice(-100), attention: records };
    try { this.persist(); } catch (error) { this.data = previous; throw error; }
    if (!duplicate) for (const listener of this.listeners) { try { listener(completion); } catch {} }
    return !duplicate;
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
    const event = remaining.find((e): e is Completion | AttentionNotification => e.kind !== "attention-resolved" && !e.viewedOnG2 && !e.forwardTo &&
      (e.kind !== "attention" || (this.attentionPending(e.attentionId) && Date.now() - e.at < ATTENTION_FRESHNESS_MS)));
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
    const title = fit("Terminal+", titleMaxLength);
    const status = event.kind === "attention" ? event.reason === "approval" ? "Needs approval" : "Needs input" :
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
