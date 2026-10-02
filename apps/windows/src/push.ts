import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Completion, NotificationJournal } from "./notifications.js";
import { FcmFailure, type FcmPayload, type PushPriority, type PushSender } from "./fcm.js";

export class PushError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export interface PushSubscription {
  id: string;
  installationId: string;
  watcher: string;
  maxLength: number;
  titleMaxLength: number;
  expiresAfterSeconds: number;
  registeredAt: number;
  lastCompletionId: number;
  disabled?: string;
}
export interface PushContent { title: string; text: string }
function fitLabel(value: string, limit: number) {
  const text = Buffer.from(value, "utf8").toString("utf8");
  if (text.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, limit);
  let prefix = text.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + "…";
}
/** Compose our own automatic content within each watcher's budget; explicit push inputs remain strict. */
function completionContent(event: Completion, subscription: PushSubscription): PushContent {
  const status = event.outcome === "completed" ? "Job complete" : event.outcome === "failed" ? "Job failed" : "Job interrupted";
  const short = event.outcome === "completed" ? "Done" : event.outcome === "failed" ? "Failed" : "Stopped";
  const title = subscription.titleMaxLength >= 10 ? "Even-Pilot" : subscription.titleMaxLength >= 2 ? "Pi" : "π";
  if (subscription.maxLength < status.length) return { title, text: short.slice(0, subscription.maxLength) };
  const budget = Math.min(512, subscription.maxLength - status.length - 3);
  if (budget < 1) return { title, text: status };
  const label = event.session.replace(/\s+/g, " ").trim() || "Pi";
  const id = event.sessionId?.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || String(event.id);
  const suffix = ` #${id}`;
  const compact = label.length > budget && budget > suffix.length + 1
    ? fitLabel(label, budget - suffix.length) + suffix : fitLabel(label, budget);
  return { title, text: `${status} · ${compact}` };
}
type JobStatus = "queued" | "sending" | "accepted" | "failed" | "expired" | "cancelled" | "uncertain";
export interface PushJob extends PushContent {
  id: string;
  subscriptionId: string;
  eventId?: number;
  createdAt: number;
  expiresAt: number;
  nextAttemptAt: number;
  attempts: number;
  priority: PushPriority;
  status: JobStatus;
  code?: string;
  acceptedAt?: number;
}
interface PushData {
  version: 1;
  subscriptions: PushSubscription[];
  retired: string[];
  jobs: PushJob[];
}
interface PushOptions {
  path?: string;
  sender?: PushSender;
  projectId?: string;
  ttlSeconds?: number;
  now?: () => number;
  random?: () => number;
  automatic?: boolean;
  diagnostic?: (message: string) => void;
}
const pending = (job: PushJob) => job.status === "queued" || job.status === "sending";
const identifier = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value))
    throw new PushError(`${name} must contain 1–200 ASCII letters, digits, _, ., : or -`);
  return value;
};
function integer(value: unknown, name: string, max: number) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new PushError(`${name} must be an integer from 1 to ${max}`);
  return Number(value);
}
export function validateContent(content: PushContent, subscription: Pick<PushSubscription, "maxLength" | "titleMaxLength">) {
  for (const [key, limit] of [["title", subscription.titleMaxLength], ["text", subscription.maxLength]] as const) {
    const value = content[key];
    if (typeof value !== "string" || !value.trim()) throw new PushError(`${key} must be nonempty`);
    if (value.length > limit) throw new PushError(`${key} exceeds this subscription's UTF-16 length limit`);
    if (Buffer.from(value, "utf8").toString("utf8") !== value) throw new PushError(`${key} contains invalid Unicode`);
  }
}
export function buildPushPayload(subscription: PushSubscription, content: PushContent, ttlSeconds: number, priority: PushPriority = "HIGH"): FcmPayload {
  validateContent(content, subscription);
  integer(ttlSeconds, "ttl_seconds", 3600);
  if (priority !== "HIGH" && priority !== "NORMAL") throw new PushError("priority must be HIGH or NORMAL");
  const payload: FcmPayload = { message: {
    fid: subscription.installationId,
    data: { subscription_id: subscription.id, title: content.title, text: content.text },
    android: { priority, ttl: `${ttlSeconds}s` },
  } };
  // Conservative bound on the entire JSON message, including UTF-8 escaping and routing fields.
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 4096) throw new PushError("FCM payload exceeds 4096 bytes");
  return payload;
}

/** One local bridge owner, matching the existing control/notification bearer model. */
export class GlancePush {
  private data: PushData = { version: 1, subscriptions: [], retired: [], jobs: [] };
  private now: () => number;
  private unsubscribe: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private processing?: Promise<void>;
  private flights = new Map<string, AbortController>();
  private closed = false;
  private blocked?: string;
  private ttl: number;
  constructor(private journal: NotificationJournal, private options: PushOptions = {}) {
    this.now = options.now || Date.now;
    this.ttl = integer(options.ttlSeconds ?? 30, "EVEN_PILOT_PUSH_TTL_SECONDS", 3600);
    if (options.path && existsSync(options.path)) {
      try {
        const data = JSON.parse(readFileSync(options.path, "utf8"));
        if (data.version !== 1 || !Array.isArray(data.subscriptions) || !Array.isArray(data.retired) || !Array.isArray(data.jobs)) throw new Error();
        this.data = data;
        for (const subscription of this.data.subscriptions) {
          this.registration({ subscription_id: subscription.id, installation_id: subscription.installationId, watcher: subscription.watcher,
            max_length: subscription.maxLength, title_max_length: subscription.titleMaxLength, expires_after_seconds: subscription.expiresAfterSeconds });
          if (!Number.isSafeInteger(subscription.lastCompletionId) || subscription.lastCompletionId < 0) throw new Error();
        }
        for (const id of this.data.retired) identifier(id, "subscription_id");
        if (new Set(this.data.subscriptions.map(s => s.id)).size !== this.data.subscriptions.length ||
            this.data.subscriptions.some(s => this.data.retired.includes(s.id))) throw new Error();
        for (const job of this.data.jobs) {
          identifier(job.id, "job id"); identifier(job.subscriptionId, "subscription_id");
          if (!["queued", "sending", "accepted", "failed", "expired", "cancelled", "uncertain"].includes(job.status) ||
              !Number.isFinite(job.expiresAt) || !Number.isFinite(job.nextAttemptAt) || !Number.isInteger(job.attempts) || job.attempts < 0) throw new Error();
          if (job.status === "sending") { job.status = "uncertain"; job.code = "PROCESS_RESTARTED_DURING_SEND"; }
        }
      } catch { throw new Error("Invalid push storage; restore .local/glance-push.json from backup before starting"); }
      this.persist();
    }
    this.unsubscribe = journal.subscribe(() => this.recoverCompletions());
    // Recover fresh events persisted by the completion journal just before a crash.
    this.recoverCompletions();
    this.schedule();
  }
  private persist() {
    this.data.jobs = [...this.data.jobs.filter(pending), ...this.data.jobs.filter(j => !pending(j)).slice(-200)];
    if (!this.options.path) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      writeFileSync(this.options.path + ".tmp", JSON.stringify(this.data), { mode: 0o600 });
      renameSync(this.options.path + ".tmp", this.options.path);
    } catch { this.blocked = "PUSH_STORAGE_FAILED"; throw new PushError("Push storage write failed", 503); }
  }
  private registration(data: Record<string, unknown>) {
    const id = identifier(data.subscription_id, "subscription_id");
    const installationId = identifier(data.installation_id, "installation_id");
    if (typeof data.watcher !== "string" || !data.watcher.trim() || data.watcher.length > 128) throw new PushError("watcher must be a nonempty name up to 128 characters");
    return { id, installationId, watcher: data.watcher,
      maxLength: integer(data.max_length, "max_length", 10_000),
      titleMaxLength: integer(data.title_max_length, "title_max_length", 10_000),
      expiresAfterSeconds: integer(data.expires_after_seconds, "expires_after_seconds", 86_400) };
  }
  register(data: Record<string, unknown>) {
    const input = this.registration(data);
    if (this.data.retired.includes(input.id)) throw new PushError("This subscription ID was retired; create a new watcher subscription", 410);
    const previous = this.data.subscriptions.find(s => s.id === input.id);
    if (!previous && this.data.subscriptions.length >= 100) throw new PushError("Push subscription limit reached", 429);
    const updated: PushSubscription = { ...input, registeredAt: this.now(),
      lastCompletionId: previous?.lastCompletionId ?? this.journal.list().at(-1)?.id ?? 0,
      disabled: previous?.installationId === input.installationId ? previous.disabled : undefined };
    this.data.subscriptions = [...this.data.subscriptions.filter(s => s.id !== input.id), updated];
    this.persist(); this.schedule();
  }
  unregister(data: Record<string, unknown>) {
    const id = identifier(data.subscription_id, "subscription_id");
    this.data.subscriptions = this.data.subscriptions.filter(s => s.id !== id);
    if (!this.data.retired.includes(id)) this.data.retired.push(id);
    for (const job of this.data.jobs.filter(j => j.subscriptionId === id && pending(j))) {
      job.status = "cancelled"; job.code = "SUBSCRIPTION_REMOVED";
      this.flights.get(job.id)?.abort();
    }
    this.persist();
  }
  private recoverCompletions() {
    // Always oldest first: a new completion cannot leapfrog an event waiting for queue capacity.
    for (const event of this.journal.list()) this.onCompletion(event);
  }
  private onCompletion(event: Completion) {
    try {
      let changed = false;
      for (const subscription of this.data.subscriptions) {
        if (event.id <= subscription.lastCompletionId) continue;
        if (event.viewedOnG2 || event.forwardTo || subscription.disabled || this.now() >= event.at + this.ttl * 1000) {
          subscription.lastCompletionId = event.id; changed = true; continue;
        }
        // Keep the cursor behind unqueued events so capacity recovery can retry them.
        if (this.data.jobs.filter(pending).length >= 500) break;
        this.enqueue(subscription.id, completionContent(event, subscription), this.ttl, "HIGH", event);
        subscription.lastCompletionId = event.id;
        changed = true;
      }
      if (changed) { this.persist(); this.schedule(); }
    } catch { this.options.diagnostic?.("Push queue could not be saved; inspect local push status."); }
  }
  private enqueue(subscriptionId: string, content: PushContent, ttl: number, priority: PushPriority, event?: Completion) {
    if (this.data.jobs.filter(pending).length >= 500) throw new PushError("Push queue is full", 503);
    const job: PushJob = { id: randomUUID(), subscriptionId, ...content, priority,
      eventId: event?.id, createdAt: event?.at ?? this.now(), expiresAt: (event?.at ?? this.now()) + ttl * 1000,
      nextAttemptAt: this.now(), attempts: 0, status: "queued" };
    this.data.jobs.push(job);
    return job;
  }
  test(data: Record<string, unknown>) {
    const id = identifier(data.subscription_id, "subscription_id");
    const subscription = this.data.subscriptions.find(s => s.id === id);
    if (!subscription) throw new PushError("Unknown active subscription", 404);
    if (subscription.disabled) throw new PushError("This destination was rejected; register a new installation address", 409);
    const content = { title: data.title, text: data.text } as PushContent;
    const ttl = integer(data.ttl_seconds ?? this.ttl, "ttl_seconds", 3600);
    const priority = (data.priority ?? "HIGH") as PushPriority;
    const payload = buildPushPayload(subscription, content, ttl, priority);
    if (data.dry_run === true) return { status: "validated_locally", bytes: Buffer.byteLength(JSON.stringify(payload)), contactedFirebase: false };
    if (data.dry_run !== undefined && data.dry_run !== false) throw new PushError("dry_run must be boolean");
    if (!this.options.sender || this.blocked) throw new PushError(this.blocked || "Set EVEN_PILOT_FCM_PROJECT_ID and server ADC credentials first", 503);
    const job = this.enqueue(id, content, ttl, priority);
    this.persist(); this.schedule();
    return { status: "queued", jobId: job.id, confirmedDelivery: false };
  }
  status() {
    return { configured: Boolean(this.options.sender), projectId: this.options.projectId ?? null,
      blocked: this.blocked ?? null, deliveryConfirmationSupported: false,
      subscriptions: this.data.subscriptions.map(({ installationId: _, ...s }) => ({ ...s })),
      retiredCount: this.data.retired.length,
      jobs: this.data.jobs.map(({ title: _, text: __, ...job }) => ({ ...job })) };
  }
  /** Public to drive deterministic local tests without real timers. */
  drain(): Promise<void> {
    if (this.processing) return this.processing;
    this.processing = this.pump().finally(() => { this.processing = undefined; this.schedule(); });
    return this.processing;
  }
  private schedule() {
    if (this.closed || this.options.automatic === false || this.processing || this.blocked === "PUSH_STORAGE_FAILED") return;
    clearTimeout(this.timer);
    const times = this.data.jobs.filter(j => j.status === "queued").map(j => Math.min(j.nextAttemptAt, j.expiresAt));
    if (!times.length) return;
    this.timer = setTimeout(() => { void this.drain().catch(() => this.options.diagnostic?.("Push worker stopped; inspect local push status.")); }, Math.max(0, Math.min(...times) - this.now()));
    this.timer.unref();
  }
  private async pump() {
    if (this.closed || this.blocked === "PUSH_STORAGE_FAILED") return;
    // At most four independent destinations in flight; slow devices don't hold every watcher.
    const due = this.data.jobs.filter(j => j.status === "queued" && (j.nextAttemptAt <= this.now() || j.expiresAt <= this.now())).slice(0, 4);
    await Promise.all(due.map(job => this.attempt(job)));
    if (!this.closed) this.recoverCompletions();
  }
  private async attempt(job: PushJob) {
    const subscription = this.data.subscriptions.find(s => s.id === job.subscriptionId);
    if (!subscription || subscription.disabled) { job.status = "cancelled"; job.code = "DESTINATION_DISABLED"; this.persist(); return; }
    const remaining = Math.floor((job.expiresAt - this.now()) / 1000);
    if (remaining < 1) { job.status = "expired"; job.code = "CONTENT_EXPIRED"; this.persist(); return; }
    if (!this.options.sender || this.blocked) { job.status = "failed"; job.code = this.blocked || "FCM_NOT_CONFIGURED"; this.persist(); return; }
    let payload: FcmPayload;
    try { payload = buildPushPayload(subscription, job, remaining, job.priority); }
    catch { job.status = "failed"; job.code = "PAYLOAD_INVALID"; this.persist(); return; }
    const destination = subscription.installationId;
    job.status = "sending"; job.attempts++; this.persist();
    const controller = new AbortController(); this.flights.set(job.id, controller);
    const timeout = setTimeout(() => controller.abort(), Math.min(10_000, remaining * 1000));
    try {
      await this.options.sender.send(payload, controller.signal, job.expiresAt);
      if (job.status === "sending") { job.status = "accepted"; job.acceptedAt = this.now(); job.code = undefined; }
    } catch (error) {
      if (job.status !== "sending") return;
      const failure = error instanceof FcmFailure ? error : new FcmFailure("uncertain", "FCM_RESPONSE_UNKNOWN");
      job.code = failure.code;
      if (failure.kind === "destination") {
        const current = this.data.subscriptions.find(s => s.id === job.subscriptionId);
        if (current?.installationId === destination) current.disabled = failure.code;
      }
      if (failure.kind === "auth") this.blocked = failure.code;
      if (failure.kind === "transient" && job.attempts < 3) {
        const backoff = 10_000 * 2 ** (job.attempts - 1) * (1 + (this.options.random || Math.random)() * .2);
        job.nextAttemptAt = this.now() + Math.max(backoff, failure.retryAfterMs);
        job.status = job.nextAttemptAt + 1000 < job.expiresAt ? "queued" : "expired";
      } else job.status = failure.kind === "uncertain" ? "uncertain" : failure.code === "CONTENT_EXPIRED" ? "expired" : "failed";
    } finally {
      clearTimeout(timeout); this.flights.delete(job.id); this.persist();
    }
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.unsubscribe();
    for (const flight of this.flights.values()) flight.abort();
    await this.processing;
  }
}
