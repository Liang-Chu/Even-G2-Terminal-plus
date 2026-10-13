import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Interaction, InteractionAnswer } from "../cockpit-state/interactions.js";
import { nativePermissionAnswer } from "../cockpit-state/interactions.js";
import { SessionError, canonicalPath } from "../pi-runtime/sessions.js";
import { InteractionBroker } from "./interactions.js";
import { claudeInteractionQuestions, claudeQuestionAnswers } from "./claude-questions.js";
import {
  cleanupNativeQuestion, genericProcessIdentity, listNativeQuestionRequests, matchesProcess,
  readClaudeQuestionFile, readNativeQuestionAvailability, readNativeQuestionConsumed,
  readNativeQuestionRequest, removeNativeQuestionAvailability, validClaudeQuestionRequest,
  writeNativeQuestionAvailability, writeNativeQuestionResponse, pruneNativeQuestionFiles,
  type ClaudeProcessIdentity, type NativeClaudeQuestionRequest,
} from "../../apps/windows/src/claude-native-question.mjs";

export interface NativeClaudeQuestionSession {
  id: string; key: string; owner: ClaudeProcessIdentity; path: string; cwd: string;
  online: boolean; monitored: boolean; canAnswer: boolean; turnAt?: number;
  attention: { id: string; kind: string; toolId?: string; createdAt?: number }[];
}
interface PendingQuestion {
  request: NativeClaudeQuestionRequest; key: string; interactionId: string;
  remove: () => void; responding: boolean;
}

/** Native hooks own the CLI. This relay can answer only their current request,
 * never submit prompts, alter permission rules or resume another copy of a session. */
export class NativeClaudeQuestions {
  private readonly instance = randomUUID();
  private backend?: ClaudeProcessIdentity;
  private brokers = new Map<string, { broker: InteractionBroker; requests: Interaction[] }>();
  private pending = new Map<string, PendingQuestion>();
  private cancelled = new Map<string, NativeClaudeQuestionRequest>();
  private stopped = false;
  private task?: Promise<void>;
  constructor(private data: string, private sessions: () => NativeClaudeQuestionSession[],
    private changed: (sessionId: string, answeredId?: string) => void,
    private options: { identify?: (pid: number) => Promise<string | undefined>; now?: () => number } = {}) {}
  private now() { return (this.options.now || Date.now)(); }
  private identify = (pid: number) => (this.options.identify || genericProcessIdentity)(pid);
  interactions(id: string) { return this.brokers.get(id)?.requests || []; }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.task ||= this.scan().finally(() => { this.task = undefined; });
  }
  private session(request: NativeClaudeQuestionRequest) {
    const session = this.sessions().find(row => row.id === request.sessionId);
    if (!session?.online || !session.monitored || session.owner.pid !== request.owner.pid
      || session.owner.started !== request.owner.started || canonicalPath(session.path) !== canonicalPath(request.transcriptPath)
      || canonicalPath(session.cwd) !== canonicalPath(request.cwd) || (session.turnAt || 0) > request.at) return;
    return session;
  }
  private context(request: NativeClaudeQuestionRequest) {
    const session = this.session(request);
    if (!session) return;
    // The corresponding sanitized lifecycle event must already have been accepted.
    const kind = request.kind || "question";
    const approvalId = createHash("sha256").update(`${request.owner.pid}:${request.owner.started}:approval:${request.eventId}`).digest("hex");
    const attention = session.attention.find(row => row.kind === kind
      && (kind === "approval" ? row.id === approvalId : row.toolId === request.toolUseId)
      && typeof row.createdAt === "number" && row.createdAt <= request.at && request.at - row.createdAt <= 10_000
      && (request.lifecycleAt === undefined || row.createdAt === request.lifecycleAt));
    return attention ? { session, attention } : undefined;
  }
  private ours(request: NativeClaudeQuestionRequest) {
    return request.backend.instance === this.instance && request.backend.pid === this.backend?.pid
      && request.backend.started === this.backend.started;
  }
  private async heartbeat() {
    if (!this.backend) {
      const started = await this.identify(process.pid);
      if (!started) return false;
      this.backend = { pid: process.pid, started };
    }
    const other = readNativeQuestionAvailability(this.data, this.now());
    if (other && other.instance !== this.instance && await matchesProcess(other.backend, this.identify)) return false;
    return writeNativeQuestionAvailability(this.data, {
      version: 1, at: this.now(), backend: this.backend, instance: this.instance,
      sessions: this.sessions().filter(row => row.online).map(row => ({ sessionId: row.id, owner: row.owner,
        // Production admits every watched session. An admitted request also
        // survives temporary viewer loss until answer or its fixed deadline.
        monitored: row.monitored && (row.canAnswer || [...this.pending.values()].some(item => item.key === row.key)),
      })),
    }, this.now());
  }
  private async scan() {
    pruneNativeQuestionFiles(this.data, this.now());
    for (const [eventId, request] of this.cancelled) {
      if (readNativeQuestionConsumed(this.data, request) || this.now() >= request.expiresAt) {
        cleanupNativeQuestion(this.data, request, { includeAck: true }); this.cancelled.delete(eventId);
      }
    }
    if (!await this.heartbeat()) {
      for (const entry of [...this.pending.values()]) this.cancel(entry);
      return;
    }
    for (const entry of [...this.pending.values()]) {
      if (entry.responding) continue;
      const current = readNativeQuestionRequest(this.data, entry.request.eventId, this.now());
      if (!current || current.nonce !== entry.request.nonce || !this.context(current)
        || !await matchesProcess(current.hook, this.identify) || !await matchesProcess(current.owner, this.identify)) this.cancel(entry);
    }
    for (const eventId of listNativeQuestionRequests(this.data)) {
      if (this.pending.has(eventId) || this.cancelled.has(eventId)) continue;
      const request = readNativeQuestionRequest(this.data, eventId, this.now());
      if (!request) {
        // A crashed hook must not permanently fill the bounded spool. Only
        // validated, expired records and their own bound files may be removed.
        const old = readClaudeQuestionFile(this.data, eventId + ".request.json");
        if (validClaudeQuestionRequest(old, old?.at) && old.expiresAt + 60_000 < this.now())
          cleanupNativeQuestion(this.data, old, { includeAck: true });
        continue;
      }
      if (!this.ours(request)) continue;
      const context = this.context(request);
      // The hook queues lifecycle before spooling the question, but may arrive
      // just after this observer's bounded queue snapshot. Allow its next scan
      // to accept that exact event instead of handing off prematurely.
      if (!context && this.session(request)?.canAnswer && this.now() - request.at < 3000) continue;
      if (!context || !context.session.canAnswer || !await matchesProcess(request.owner, this.identify)
        || !await matchesProcess(request.hook, this.identify)) {
        writeNativeQuestionResponse(this.data, request, { action: "cancel" }, this.now());
        this.cancelled.set(eventId, request);
        continue;
      }
      const permission = request.kind === "approval" ? request.input.permission : undefined;
      const questions = permission ? [{ id: "decision", text: "Allow this operation once?", allowText: true,
        options: [{ id: "allow", label: "Allow once" }, { id: "deny", label: "Deny" }] }]
        : request.input.questions ? claudeInteractionQuestions(request.input.questions) : undefined;
      if (!questions) {
        writeNativeQuestionResponse(this.data, request, { action: "cancel" }, this.now());
        this.cancelled.set(eventId, request); continue;
      }
      let row = this.brokers.get(request.sessionId);
      if (!row) {
        row = { requests: [], broker: new InteractionBroker(requests => {
          this.brokers.get(request.sessionId)!.requests = requests;
          this.changed(request.sessionId);
        }) };
        this.brokers.set(request.sessionId, row);
      }
      const entry: PendingQuestion = { request, key: context.session.key, interactionId: context.attention.id,
        responding: false, remove: () => {} };
      this.pending.set(eventId, entry);
      try {
        entry.remove = row.broker.add(eventId, { kind: permission ? "approval" : "question",
          title: permission ? "Claude needs permission" : "Claude needs your answer", questions,
          ...(permission ? { detail: JSON.stringify({ tool: permission.toolName, input: permission.toolInput }) } : {}),
          createdAt: context.attention.createdAt, expiresAt: request.expiresAt, cancelable: true,
          cancelLabel: "Answer in original terminal" },
        answer => this.deliver(entry, answer), entry.interactionId);
      } catch { this.cancel(entry); }
    }
    for (const [id, row] of this.brokers) if (!row.requests.length
      && ![...this.pending.values()].some(entry => entry.request.sessionId === id)) this.brokers.delete(id);
  }
  private cancel(entry: PendingQuestion) {
    if (this.ours(entry.request)) writeNativeQuestionResponse(this.data, entry.request, { action: "cancel" }, this.now());
    this.cancelled.set(entry.request.eventId, entry.request);
    this.pending.delete(entry.request.eventId); entry.remove();
    // Keep the lifecycle attention marker: falling back still leaves a native
    // question waiting, not a completed task.
  }
  async respond(key: string, answer: InteractionAnswer) {
    const entry = [...this.pending.values()].find(item => item.key === key && item.interactionId === answer?.requestId);
    if (!entry || entry.responding || this.context(entry.request)?.session.key !== key) throw new SessionError("This Claude question is no longer available. Answer in the original terminal.", 409);
    // Validate number lists before the once-only broker claims the answer.
    if (!answer.cancel) this.answers(entry.request, answer.answers);
    await this.brokers.get(entry.request.sessionId)!.broker.respond(answer);
  }
  private answers(request: NativeClaudeQuestionRequest, answer: Record<string, string>) {
    if (request.kind === "approval") {
      const decision = answer && typeof answer === "object" && !Array.isArray(answer) && Object.keys(answer).length === 1
        && typeof answer.decision === "string" ? nativePermissionAnswer(answer.decision) : undefined;
      if (!decision) throw new SessionError("Answer allow once or deny.");
      return { decision };
    }
    if (!request.input.questions) throw new SessionError("Unsupported Claude question");
    return claudeQuestionAnswers(request.input.questions, answer);
  }
  private async deliver(entry: PendingQuestion, answer: InteractionAnswer) {
    entry.responding = true;
    const request = entry.request;
    try {
      const current = readNativeQuestionRequest(this.data, request.eventId, this.now());
      if (this.stopped || !current || current.nonce !== request.nonce || !this.ours(current) || !this.context(current)
        || !await matchesProcess(current.owner, this.identify) || !await matchesProcess(current.hook, this.identify))
        throw new SessionError("This Claude question changed. Answer in the original terminal.", 409);
      const response = answer.cancel ? { action: "cancel" as const } : { action: "answer" as const,
        answers: this.answers(request, answer.answers) };
      if (!writeNativeQuestionResponse(this.data, request, response, this.now()))
        throw new SessionError("Claude did not accept delivery. Check the original terminal before retrying.", 409);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const receipt = readNativeQuestionConsumed(this.data, request);
        if (receipt) {
          if (receipt.action !== response.action || JSON.stringify(receipt.answers) !== JSON.stringify(response.answers))
            throw new SessionError("Claude delivery could not be confirmed. Check the original terminal.", 409);
          if (!answer.cancel) this.changed(request.sessionId, entry.interactionId);
          return;
        }
        if (this.stopped || !this.context(request) || this.now() >= request.expiresAt)
          throw new SessionError("Claude stopped waiting for this question. Answer in the original terminal.", 409);
        await delay(100);
      }
      throw new SessionError("Claude delivery was not confirmed. Check the original terminal before retrying.", 504);
    } finally {
      this.pending.delete(request.eventId); entry.remove();
      cleanupNativeQuestion(this.data, request, { includeAck: true });
    }
  }
  async stop() {
    this.stopped = true;
    await this.task?.catch(() => {});
    removeNativeQuestionAvailability(this.data, this.instance);
    for (const entry of [...this.pending.values()]) this.cancel(entry);
    this.brokers.clear();
  }
}
