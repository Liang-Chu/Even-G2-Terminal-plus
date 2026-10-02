import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CockpitStore } from "../cockpit-state/store.js";
import type { RuntimeState } from "../cockpit-state/types.js";
import { readLocalJson, writeLocalJson, type NativeCommand, type NativeSnapshot } from "../pi-runtime/native-protocol.js";
import { InteractionBroker } from "./interactions.js";

/** One native window owns this publisher, independently of the desktop monitor. */
export class ConnectorMonitor {
  readonly store: CockpitStore;
  readonly snapshot: NativeSnapshot;
  private timer?: NodeJS.Timeout;
  private sending = false;
  private pendingReply?: { path: string; value: { id: string; error?: string }; expiresAt: number };
  private mainBusy = false;
  private completionPending = false;
  private outcome: "completed" | "interrupted" | "failed" = "completed";
  readonly subagents = new Set<string>();
  readonly interactions = new InteractionBroker(requests => {
    this.store.publish({ ...this.store.state, interactions: requests }, { type: "monitoring.updated" });
  });
  constructor(readonly directory: string, session: RuntimeState["session"],
    private commands: { prompt(text: string): Promise<void>; interrupt?(command: NativeCommand): Promise<void> }) {
    this.store = new CockpitStore(session.cwd);
    this.store.dispatch({ type: "session.updated", session });
    this.store.dispatch({ type: "runtime.connected" });
    this.store.state.capabilities = { interrupt: !!commands.interrupt };
    this.snapshot = { version: 1, instance: randomUUID(), pid: process.pid, at: 0, updatedAt: Date.now(),
      runId: 0, completions: [], state: this.store.state };
  }
  start() { clearInterval(this.timer); this.publish(); this.timer = setInterval(() => { this.publish(); void this.poll(); }, 250); }
  changeSession(session: RuntimeState["session"]) {
    this.interactions.clear();
    this.mainBusy = false; this.completionPending = false; this.subagents.clear();
    this.snapshot.instance = randomUUID(); this.snapshot.completions = []; this.snapshot.runId = 0;
    this.store.dispatch({ type: "session.reset" }); this.store.dispatch({ type: "session.updated", session });
    this.store.dispatch({ type: "runtime.connected" }); this.store.state.capabilities = { interrupt: !!this.commands.interrupt };
    this.activity(); this.publish();
  }
  activity() { this.snapshot.updatedAt = Date.now(); }
  begin() {
    if (!this.mainBusy && !this.completionPending) {
      this.interactions.clear();
      this.snapshot.runId = Math.max(Date.now(), this.snapshot.runId + 1);
      this.store.dispatch({ type: "agent.started" }); this.outcome = "completed";
    }
    this.mainBusy = true; this.completionPending = true; this.publishCounts(); this.activity();
  }
  child(id: string, active: boolean) {
    if (active) this.subagents.add(id); else this.subagents.delete(id);
    this.publishCounts();
    this.activity(); this.settle();
  }
  end(outcome: "completed" | "interrupted" | "failed" = "completed") {
    this.mainBusy = false; this.outcome = outcome; this.publishCounts(); this.settle();
  }
  private publishCounts() {
    this.store.publish({ ...this.store.state, subagents: { active: this.subagents.size, mainDelegated: !this.mainBusy } }, { type: "monitoring.updated" });
  }
  private settle() {
    if (this.mainBusy || this.subagents.size || !this.completionPending) return;
    this.completionPending = false;
    this.interactions.clear();
    this.store.state.main = { ...this.store.state.main, outcome: this.outcome,
      error: this.outcome === "failed" ? this.store.state.main.error || "Agent run failed" : undefined };
    this.store.dispatch({ type: "agent.settled" });
    this.snapshot.completions = [...this.snapshot.completions, { id: this.snapshot.runId, at: Date.now(), outcome: this.outcome }].slice(-50);
    this.activity(); this.publish();
  }
  waiting() {
    this.store.publish({ ...this.store.state, main: { ...this.store.state.main, status: "waiting" } }, { type: "monitoring.updated" });
    this.activity();
  }
  publish() {
    this.interactions.prune();
    let budget = 60_000;
    const transcript = this.store.state.transcript.slice(-80).reverse().flatMap(entry => {
      if (budget <= 0) return [];
      const text = entry.text.slice(-Math.min(budget, 12_000)); budget -= text.length; return [{ ...entry, text }];
    }).reverse();
    this.snapshot.state = { ...this.store.state, transcript, currentAssistantText: this.store.state.currentAssistantText.slice(-20_000) };
    this.snapshot.at = Date.now();
    try { writeLocalJson(join(this.directory, this.snapshot.pid + ".json"), this.snapshot); }
    catch { /* Monitoring storage failure cannot terminate the user's agent. */ }
  }
  async poll() {
    if (this.sending) return;
    // Windows readers/antivirus can briefly deny the atomic rename. Retry only
    // its acknowledgement; executing the prompt again would duplicate work.
    if (!this.flushReply()) return;
    const instance = this.snapshot.instance;
    const path = join(this.directory, instance + ".command.json");
    if (!existsSync(path)) return;
    this.sending = true;
    let command: NativeCommand | undefined, error: string | undefined;
    try {
      command = readLocalJson(path); unlinkSync(path);
      if (!command || command.instance !== this.snapshot.instance || command.key !== this.store.state.session.key
        || !Number.isFinite(command.expiresAt) || command.expiresAt < Date.now()) throw new Error("Session changed or command expired");
      if (command.type === "respond") {
        if (!command.answer) throw new Error("Missing answer");
        await this.interactions.respond(command.answer);
      } else if (command.type === "prompt") {
        if (["running", "waiting"].includes(this.store.state.main.status)) throw new Error("Agent is working; wait before sending another prompt");
        if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 32_000) throw new Error("Invalid prompt");
        await this.commands.prompt(command.text);
      } else if (command.type === "interrupt" && this.commands.interrupt) {
        if (command.runId !== this.snapshot.runId || !["running", "waiting"].includes(this.store.state.main.status))
          throw new Error("The running instruction changed. Stop was not sent.");
        await this.commands.interrupt(command);
      }
      else throw new Error("Use Ctrl+C in this native terminal to interrupt");
    } catch (reason) { error = reason instanceof Error ? reason.message : "Command failed"; }
    finally {
      if (command && typeof command.id === "string") {
        this.pendingReply = { path: join(this.directory, instance + ".reply.json"), value: { id: command.id, error }, expiresAt: Date.now() + 5000 };
        this.flushReply();
      }
      this.sending = false;
    }
  }
  private flushReply() {
    const reply = this.pendingReply;
    if (!reply) return true;
    try { writeLocalJson(reply.path, reply.value); this.pendingReply = undefined; }
    catch { if (Date.now() >= reply.expiresAt) this.pendingReply = undefined; }
    return !this.pendingReply;
  }
  stop() {
    clearInterval(this.timer);
    this.interactions.clear();
    // Connection loss is never a completion. Do not replay uncertain commands.
    this.store.publish({ ...this.store.state, connected: false }, { type: "monitoring.updated" }); this.publish();
  }
}
