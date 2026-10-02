import { randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CockpitStore } from "../../../packages/cockpit-state/store.js";
import { normalizePiEvent } from "../../../packages/pi-runtime/event-normalizer.js";
import { historyMessages, sessionKey } from "../../../packages/pi-runtime/sessions.js";
import { readLocalJson, writeLocalJson, type NativeSnapshot, type NativeCommand } from "../../../packages/pi-runtime/native-protocol.js";
import { dataDirectory } from "./config.js";
import { PiSubagentTracker } from "../../../packages/pi-runtime/subagent-tracker.js";
import { promptLabel } from "../../../packages/cockpit-state/selectors.js";
import { InteractionBroker } from "../../../packages/connectors/interactions.js";
import { piCommand, type PiCommandContext } from "../../../packages/connectors/pi-commands.js";

// Structural types keep this small local extension independent of Pi's npm layout.
interface PiContext extends PiCommandContext {
  mode: string; cwd: string; model?: { provider: string; id: string };
  isIdle(): boolean; abort(): void;
  sessionManager: { getSessionFile(): string | undefined; getSessionId(): string; getSessionName(): string | undefined; getBranch(): any[] };
}
interface PiApi {
  on(event: string, handler: (event: any, ctx: PiContext) => void): unknown;
  sendUserMessage(text: string): void;
  setModel?(model: { provider: string; id: string }): Promise<boolean>;
}

/** Observe the actual Pi TUI. Never launch an agent, fork its session, or alter its prompts. */
export default function monitor(pi: PiApi) {
  let timer: NodeJS.Timeout | undefined, ctx: PiContext | undefined, snapshot: NativeSnapshot | undefined;
  let store: CockpitStore, dirty = false, lastWrite = 0;
  const subagents = new PiSubagentTracker();
  let inferredName: string | undefined;
  let polling = false;
  const interactions = new InteractionBroker(requests => {
    if (store) { store.publish({ ...store.state, interactions: requests }, { type: "monitoring.updated" }); dirty = true; }
  });
  const commandStatus = (text: string) => { store.publish({ ...store.state, commandStatus: text }, { type: "monitoring.updated" }); dirty = true; };
  const directory = join(dataDirectory(), "native");
  const snapshotPath = join(directory, `${process.pid}.json`);
  function publish() {
    if (!snapshot) return;
    const state = store.state;
    // Only visible text, with a total bound; no thinking, raw tools or model secrets.
    let budget = 60_000;
    const transcript = state.transcript.slice(-80).reverse().flatMap(entry => {
      if (budget <= 0) return [];
      const text = entry.text.slice(-Math.min(budget, 12_000)); budget -= text.length;
      return [{ ...entry, text }];
    }).reverse();
    snapshot.state = { ...state, transcript, currentAssistantText: state.currentAssistantText.slice(-20_000) };
    snapshot.at = Date.now();
    writeLocalJson(snapshotPath, snapshot); dirty = false; lastWrite = snapshot.at;
  }
  async function tick() {
    if (!snapshot || !ctx || polling) return;
    polling = true;
    try {
      interactions.prune();
      const path = join(directory, `${snapshot.instance}.command.json`);
      if (existsSync(path)) {
        const command = readLocalJson(path) as NativeCommand;
        const replyInstance = snapshot.instance;
        // Claim by removing before execution. An uncertain command is never replayed.
        unlinkSync(path);
        let error: string | undefined;
        try {
          if (command.instance !== snapshot.instance || command.key !== store.state.session.key || !Number.isFinite(command.expiresAt) || command.expiresAt < Date.now()) throw new Error("The terminal changed session or the request expired");
          if (command.type === "respond") {
            if (!command.answer) throw new Error("Missing answer");
            await interactions.respond(command.answer);
          } else if (command.type === "prompt") {
            if (!ctx.isIdle()) throw new Error("Pi is working; wait before sending another prompt");
            if (store.state.commandStatus === "Compacting context…") throw new Error("Pi is compacting context; wait before sending another command");
            if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 32_000) throw new Error("Invalid prompt");
            const instance = snapshot.instance;
            if (!await piCommand(command.text, ctx, pi, interactions, commandStatus, () => snapshot?.instance === instance)) {
              commandStatus(""); pi.sendUserMessage(command.text);
            }
          } else if (command.type === "interrupt") {
            if (command.runId !== snapshot.runId || ctx.isIdle()) throw new Error("The running instruction changed. Stop was not sent.");
            ctx.abort();
          }
          else throw new Error("Unknown command");
        } catch (reason) { error = reason instanceof Error ? reason.message : "Could not deliver command"; }
        writeLocalJson(join(directory, `${replyInstance}.reply.json`), { id: command.id, error });
      }
      if (dirty || Date.now() - lastWrite > 2000) publish();
    } catch { /* A stopped/restarting monitor must never disrupt the user's terminal. */ }
    finally { polling = false; }
  }
  pi.on("session_start", (_event, context) => {
    interactions.clear();
    clearInterval(timer); ctx = undefined; snapshot = undefined; subagents.reset(); inferredName = undefined;
    if (context.mode !== "tui") return;
    ctx = context; store = new CockpitStore(ctx.cwd);
    const file = ctx.sessionManager.getSessionFile();
    const key = sessionKey(file || `native-${process.pid}-${ctx.sessionManager.getSessionId()}`);
    store.dispatch({ type: "session.updated", session: { key, id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
      name: ctx.sessionManager.getSessionName(), tunnel: "pi", model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined } });
    const history = historyMessages(ctx.sessionManager.getBranch().filter(entry => entry.type === "message").map(entry => ({ ...entry.message, timestamp: entry.message?.timestamp || entry.timestamp })));
    store.dispatch({ type: "session.history", transcript: history.messages.map((entry, id) => ({ ...entry, id, at: entry.at || 0 })) });
    inferredName = promptLabel(history.messages.find(entry => entry.role === "user")?.text || "") || undefined;
    store.dispatch({ type: "session.updated", session: { name: ctx.sessionManager.getSessionName() || inferredName } });
    store.dispatch({ type: "runtime.connected" });
    if (!ctx.isIdle()) store.dispatch({ type: "agent.started" });
    let updatedAt = Date.now();
    try { if (file) updatedAt = statSync(file).mtimeMs; } catch {}
    snapshot = { version: 1, instance: randomUUID(), pid: process.pid, at: 0, updatedAt, sessionFile: file,
      runId: ctx.isIdle() ? 0 : Date.now(), completions: [], state: store.state };
    dirty = true; tick(); timer = setInterval(tick, 250); timer.unref();
  });
  for (const name of ["agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    pi.on(name, (raw, context) => {
      if (!snapshot) return;
      ctx = context;
      const counts = subagents.update(raw);
      if (JSON.stringify(counts) !== JSON.stringify(store.state.subagents)) {
        store.publish({ ...store.state, subagents: counts }, { type: "monitoring.updated" }); dirty = true;
      }
      for (const event of normalizePiEvent(raw)) {
        store.dispatch(event); snapshot.updatedAt = Date.now(); dirty = true;
        if (event.type === "user.message" && !inferredName) {
          inferredName = promptLabel(event.text) || undefined;
          store.dispatch({ type: "session.updated", session: { name: context.sessionManager.getSessionName() || inferredName } });
        }
        if (event.type === "agent.started") { interactions.clear(); snapshot.runId = Math.max(snapshot.runId + 1, Date.now()); }
        if (event.type === "agent.settled") snapshot.completions = [...snapshot.completions,
          { id: snapshot.runId, at: Date.now(), outcome: store.state.main.outcome || "completed" }].slice(-50);
      }
    });
  }
  pi.on("session_info_changed", (_event, context) => {
    if (!snapshot) return;
    store.dispatch({ type: "session.updated", session: { name: context.sessionManager.getSessionName() || inferredName } });
    snapshot.updatedAt = Date.now(); dirty = true;
  });
  pi.on("model_select", (event, context) => {
    if (!snapshot) return;
    ctx = context;
    const model = event.model || context.model;
    store.dispatch({ type: "session.updated", session: { model: model ? `${model.provider}/${model.id}` : undefined } });
    dirty = true;
  });
  pi.on("ui_prompt_start", () => {
    if (snapshot) commandStatus("Pi is waiting for a terminal dialog. Complete this custom dialog in Terminal.");
  });
  pi.on("ui_prompt_end", () => {
    if (snapshot && store.state.commandStatus?.startsWith("Pi is waiting for a terminal dialog")) commandStatus("");
  });
  pi.on("session_shutdown", () => {
    interactions.clear();
    clearInterval(timer);
    if (!snapshot) return;
    store.dispatch({ type: "runtime.exited", expected: true });
    try { publish(); } catch {}
    snapshot = undefined; ctx = undefined;
  });
}
