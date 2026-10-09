import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HostSource } from "../../../packages/cockpit-state/types.js";
import { type NotificationEvent, NotificationJournal, ATTENTION_FRESHNESS_MS } from "./notifications.js";
import { PushError } from "./push.js";

interface Target { id: string; name: string; url: string; key: string }
interface Peer { id: string; name: string; hash: string }
interface Pending { event: NotificationEvent; attempts: number; nextAt: number }
interface Data { version: 1; target?: Target; peers: Peer[]; cursor: number; pending: Pending[]; lastResult?: string }
const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const idPattern = /^[a-f0-9-]{36}$/;
const lifetime = 10 * 60_000;
const label = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 128 && !/[\r\n\x00]/.test(value);
function relayEvent(value: any): NotificationEvent {
  if (!value || !Number.isSafeInteger(value.id) || value.id < 1 || !Number.isFinite(value.at) || value.at < 0 ||
    typeof value.session !== "string" || !value.session.trim() || value.session.length > 2048 ||
    (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length > 256)) ||
    (value.sessionKey !== undefined && (typeof value.sessionKey !== "string" || !/^[a-f0-9]{32}$/.test(value.sessionKey))) ||
    (value.viewedOnG2 !== undefined && typeof value.viewedOnG2 !== "boolean") ||
    (value.forwardTo !== undefined && (typeof value.forwardTo !== "string" || !idPattern.test(value.forwardTo))) || value.relayedFrom)
    throw new PushError("Invalid relayed notification");
  const base = { id: value.id, at: value.at, session: value.session, sessionId: value.sessionId,
    sessionKey: value.sessionKey, viewedOnG2: value.viewedOnG2, forwardTo: value.forwardTo };
  if (value.kind === "attention" || value.kind === "attention-resolved") {
    if (typeof value.attentionId !== "string" || !/^[a-f0-9]{64}$/.test(value.attentionId))
      throw new PushError("Invalid relayed notification");
    if (value.kind === "attention-resolved") return { ...base, kind: value.kind, attentionId: value.attentionId };
    if (!["approval", "question", "terminal-input"].includes(value.reason) ||
      (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt < 0)))
      throw new PushError("Invalid relayed notification");
    return { ...base, kind: value.kind, attentionId: value.attentionId, reason: value.reason, expiresAt: value.expiresAt };
  }
  if ((value.kind !== undefined && value.kind !== "completion") || !["completed", "failed", "interrupted"].includes(value.outcome))
    throw new PushError("Invalid relayed notification");
  return { ...base, outcome: value.outcome };
}
function origin(value: unknown) {
  if (typeof value !== "string") throw new PushError("Choose a relay computer URL");
  let url: URL; try { url = new URL(value); } catch { throw new PushError("Invalid relay computer URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new PushError("Relay URL must be an HTTP(S) origin without credentials or path");
  return url.origin;
}

/** Durable, ordered, one-hop completion forwarding. Peer keys cannot control a terminal. */
export class NotificationRelay {
  private data: Data = { version: 1, peers: [], cursor: 0, pending: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private processing?: Promise<void>;
  private flight?: AbortController;
  private flightAttentionId?: string;
  private closed = false;
  private configuring = false;
  private storageFailed = false;
  private revision = 0;
  private unsubscribe: () => void;
  private now: () => number;
  constructor(private journal: NotificationJournal, private options: {
    path?: string; identity: HostSource; canSend: () => boolean; automatic?: boolean; now?: () => number;
    fetch?: typeof fetch;
  }) {
    this.now = options.now || Date.now;
    if (options.path && existsSync(options.path)) {
      try {
        this.data = JSON.parse(readFileSync(options.path, "utf8"));
        if (this.data.version !== 1 || !Array.isArray(this.data.peers) || this.data.peers.length > 32 || !Array.isArray(this.data.pending) ||
          this.data.pending.length > 500 || !Number.isSafeInteger(this.data.cursor) || this.data.cursor < 0) throw new Error();
        if (this.data.target) this.validateTarget(this.data.target);
        for (const peer of this.data.peers) if (!idPattern.test(peer.id) || !label(peer.name) || !/^[a-f0-9]{64}$/.test(peer.hash)) throw new Error();
        for (const item of this.data.pending) {
          item.event = relayEvent(item.event);
          if (!Number.isFinite(item.nextAt) || !Number.isSafeInteger(item.attempts) || item.attempts < 0) throw new Error();
        }
      } catch { throw new Error("Invalid notification routing storage; restore notification-routing.json from backup"); }
    }
    this.journal.forwardingTarget = () => this.data.target?.id;
    this.unsubscribe = journal.subscribe(() => { try { this.capture(); } catch { /* Persisted journal can recover after restart; do not disrupt agent monitoring. */ } });
    this.capture();
  }
  private persist() {
    if (!this.options.path) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.options.path + ".tmp", JSON.stringify(this.data), { mode: 0o600 });
      renameSync(this.options.path + ".tmp", this.options.path);
    } catch { this.storageFailed = true; throw new PushError("Notification routing storage failed; restore writable storage and restart", 503); }
  }
  private validateTarget(data: any): Target {
    if (!data || !idPattern.test(data.id) || data.id === this.options.identity.id || !label(data.name) ||
      typeof data.key !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(data.key)) throw new PushError("Invalid relay destination");
    return { id: data.id, name: data.name.trim(), url: origin(data.url), key: data.key };
  }
  status() {
    return { mode: this.data.target ? "relay" : "direct", host: this.options.identity,
      target: this.data.target && { id: this.data.target.id, name: this.data.target.name, url: this.data.target.url },
      senderConfigured: this.options.canSend(), sources: this.data.peers.map(({ hash: _, ...peer }) => peer),
      queued: this.data.pending.length, lastResult: this.storageFailed ? "Routing storage failed; restart after repair" : this.data.lastResult || null };
  }
  register(data: Record<string, unknown>) {
    if (this.configuring || this.storageFailed) throw new PushError("Notification routing is unavailable; retry shortly", 503);
    if (this.data.target) throw new PushError("This computer forwards elsewhere. Select a direct sender as the center.", 409);
    if (!this.options.canSend()) throw new PushError("Configure FCM sending credentials on the center first.", 409);
    if (typeof data.sourceId !== "string" || !idPattern.test(data.sourceId) || data.sourceId === this.options.identity.id || !label(data.sourceName))
      throw new PushError("Invalid source computer identity");
    if (!this.data.peers.some(peer => peer.id === data.sourceId) && this.data.peers.length >= 32) throw new PushError("Relay source limit reached", 429);
    const key = randomBytes(32).toString("base64url");
    this.data.peers = [...this.data.peers.filter(peer => peer.id !== data.sourceId), { id: data.sourceId, name: (data.sourceName as string).trim(), hash: digest(key) }];
    this.persist();
    return { id: this.options.identity.id, name: this.options.identity.name, key };
  }
  revoke(id: unknown) {
    if (typeof id !== "string" || !idPattern.test(id)) throw new PushError("Invalid source identity");
    this.data.peers = this.data.peers.filter(peer => peer.id !== id); this.persist();
  }
  private authenticate(key: string) {
    if (this.storageFailed) throw new PushError("Notification routing storage unavailable", 503);
    if (!/^[a-zA-Z0-9_-]{43}$/.test(key)) throw new PushError("Invalid relay credential", 401);
    const hash = Buffer.from(digest(key));
    const peer = this.data.peers.find(peer => timingSafeEqual(hash, Buffer.from(peer.hash)));
    if (!peer) throw new PushError("Invalid relay credential", 401);
    if (this.data.target) throw new PushError("Relay chains are not supported", 409);
    if (!this.options.canSend()) throw new PushError("Relay sender is not configured", 503);
    return peer;
  }
  probe(key: string) { this.authenticate(key); return { id: this.options.identity.id, ready: true }; }
  receive(key: string, data: Record<string, unknown>) {
    const peer = this.authenticate(key), event = relayEvent(data.event);
    if (event.at > this.now() + 60_000 || event.forwardTo !== this.options.identity.id)
      throw new PushError("Invalid relayed notification");
    if (event.viewedOnG2 || this.now() - event.at >= (event.kind === "attention" ? ATTENTION_FRESHNESS_MS : lifetime) ||
      (event.kind === "attention" && event.expiresAt !== undefined && event.expiresAt <= this.now())) return { accepted: false, skipped: true };
    // A tolerated source clock skew must not turn a 30-second delivery window
    // into a longer-lived notice on the center.
    if (event.kind === "attention") event.expiresAt = Math.min(event.expiresAt ?? Infinity, event.at + ATTENTION_FRESHNESS_MS, this.now() + ATTENTION_FRESHNESS_MS);
    return { accepted: true, inserted: this.journal.receiveRelay(peer.id, peer.name, event) };
  }
  async configure(data: Record<string, unknown>) {
    if (this.configuring || this.storageFailed) throw new PushError("Notification routing is unavailable; retry shortly", 503);
    this.configuring = true;
    try {
    if (!["direct", "relay"].includes(String(data.mode))) throw new PushError("Choose direct or relay notification delivery");
    if (data.mode === "relay" && this.data.peers.length) throw new PushError("Disconnect incoming relay sources before forwarding this center elsewhere", 409);
    const target = data.mode === "relay" ? this.validateTarget(data.target) : undefined;
    if (target) {
      const response = await this.send(target, "/api/glance/relay/probe", {});
      if (!response.ok || (await response.json() as any).id !== target.id) throw new PushError("Relay verification failed. Reconnect the center and try again.", 409);
    }
    this.revision++; this.flight?.abort();
    this.data.target = target; this.data.pending = []; this.data.lastResult = "Configuration saved";
    this.data.cursor = this.journal.list().at(-1)?.id || this.data.cursor;
    this.persist(); this.schedule();
    return this.status();
    } finally { this.configuring = false; }
  }
  private capture() {
    for (const event of this.journal.list(this.data.cursor)) {
      if (event.forwardTo === this.data.target?.id && event.forwardTo && !event.viewedOnG2 && !event.relayedFrom && this.fresh(event)) {
        if (this.data.pending.length >= 500) break;
        this.data.pending.push({ event: relayEvent(event), attempts: 0, nextAt: this.now() });
      }
      this.data.cursor = event.id;
    }
    if (this.flightAttentionId && !this.journal.attentionPending(this.flightAttentionId, this.now())) this.flight?.abort();
    this.persist(); this.schedule();
  }
  private fresh(event: NotificationEvent) {
    return this.now() - event.at < (event.kind === "attention" ? ATTENTION_FRESHNESS_MS : lifetime) &&
      (event.kind !== "attention" || this.journal.attentionPending(event.attentionId, this.now()));
  }
  private send(target: Target, path: string, body: unknown, signal?: AbortSignal) {
    return (this.options.fetch || fetch)(target.url + path, { method: "POST", redirect: "error", credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${target.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.closed || this.storageFailed || this.processing || this.options.automatic === false || !this.data.target || !this.data.pending.length) return;
    this.timer = setTimeout(() => { void this.drain().catch(() => {}); }, Math.max(0, this.data.pending[0].nextAt - this.now())); this.timer.unref();
  }
  drain() {
    if (this.processing) return this.processing;
    this.processing = this.pump().finally(() => { this.processing = undefined; this.schedule(); }); return this.processing;
  }
  private async pump() {
    const target = this.data.target, revision = this.revision;
    if (!target || this.closed || this.storageFailed) return;
    while (this.data.pending.length && !this.closed && revision === this.revision) {
      const item = this.data.pending[0];
      if (!this.fresh(item.event)) { this.data.pending.shift(); this.data.lastResult = "Expired or resolved"; this.persist(); continue; }
      if (item.nextAt > this.now()) break;
      this.flight = new AbortController(); this.flightAttentionId = item.event.kind === "attention" ? item.event.attentionId : undefined; item.attempts++;
      try {
        const response = await this.send(target, "/api/glance/relay/event", { event: item.event }, this.flight.signal);
        if (revision !== this.revision || this.closed) return;
        if (!response.ok) throw new Error(`Center returned HTTP ${response.status}`);
        const result = await response.json() as any;
        if (revision !== this.revision || this.closed) return;
        if (result.accepted !== true && result.skipped !== true) throw new Error("Invalid center acknowledgement");
        this.data.pending.shift(); this.data.lastResult = result.skipped ? "Expired or suppressed" : "Accepted by center";
      } catch {
        if (revision !== this.revision || this.closed) return;
        if (!this.fresh(item.event)) { this.data.pending.shift(); this.persist(); continue; }
        item.nextAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(item.attempts - 1, 5));
        this.data.lastResult = "Waiting for center; retrying";
        this.persist(); break;
      } finally { this.flight = undefined; this.flightAttentionId = undefined; }
      this.persist();
    }
    if (!this.closed && revision === this.revision) this.capture();
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.unsubscribe(); this.flight?.abort(); await this.processing;
  }
}
