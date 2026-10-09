import { randomUUID } from "node:crypto";
import type { Interaction, InteractionAnswer } from "../cockpit-state/interactions.js";

/** Short-lived, session-owned requests. Replies are claimed once, never replayed. */
export class InteractionBroker {
  private pending = new Map<string, { request: Interaction; reply: (answer: InteractionAnswer) => Promise<void> }>();
  constructor(private changed: (requests: Interaction[]) => void) {}
  add(source: string, request: Omit<Interaction, "id" | "expiresAt"> & { expiresAt?: number }, reply: (answer: InteractionAnswer) => Promise<void>) {
    if (this.pending.has(source)) return () => {};
    if (this.pending.size >= 8) throw new Error("Too many pending choices; answer in Terminal");
    if (!request.questions.length || request.questions.length > 12 || new Set(request.questions.map(q => q.id)).size !== request.questions.length
      || request.questions.some(q => !q.id || q.options.length > 200 || new Set(q.options.map(o => o.id)).size !== q.options.length))
      throw new Error("Unsupported choice form; answer in Terminal");
    const item = { request: { ...request, id: randomUUID(), createdAt: Date.now(), expiresAt: request.expiresAt || Date.now() + 10 * 60_000 }, reply };
    // Bound snapshots without silently truncating the decision the user approves.
    if (JSON.stringify(item.request).length > 24_000) throw new Error("Choice is too large; answer in Terminal");
    this.pending.set(source, item); this.emit();
    return () => { if (this.pending.get(source) === item) this.remove(source); };
  }
  remove(source: string) { if (this.pending.delete(source)) this.emit(); }
  clear() { this.pending.clear(); this.emit(); }
  prune() {
    let changed = false;
    for (const [key, value] of this.pending) if (value.request.expiresAt <= Date.now()) { this.pending.delete(key); changed = true; }
    if (changed) this.emit();
  }
  async respond(answer: InteractionAnswer) {
    if (answer?.cancel !== undefined && typeof answer.cancel !== "boolean") throw new Error("Invalid answer");
    this.prune();
    const entry = [...this.pending].find(([, value]) => value.request.id === answer?.requestId);
    if (!entry) throw new Error("This choice has expired or was already answered. Refresh the session.");
    const [source, { request, reply }] = entry;
    if (answer.cancel) {
      if (!request.cancelable) throw new Error("Choose an explicit option to answer this request");
    } else {
      if (!answer.answers || typeof answer.answers !== "object" || Array.isArray(answer.answers)) throw new Error("Invalid answer");
      if (Object.keys(answer.answers).length !== request.questions.length) throw new Error("Answer every question");
      for (const q of request.questions) {
        const value = answer.answers[q.id];
        if (typeof value !== "string" || !value.trim() || value.length > 8000
          || (!q.allowText && !q.options.some(o => o.id === value))) throw new Error("Choose one of the current options");
      }
    }
    this.remove(source);
    await reply(answer);
  }
  private emit() { this.changed([...this.pending.values()].map(p => p.request)); }
}
