import type { ConnectorMonitor } from "./monitor.js";

/** Translate only public app-server events; never expose reasoning or raw tool output. */
export class CodexEvents {
  turnId?: string;
  private text = new Map<string, string>();
  private completed = new Set<string>();
  constructor(readonly threadId: string, private monitor: ConnectorMonitor) {}
  receive(message: { method: string; id?: unknown; params?: any }) {
    const p = message.params || {}, method = message.method;
    if (p.threadId !== this.threadId) {
      if (method === "thread/status/changed" && this.monitor.subagents.has(p.threadId)
        && ["active", "idle", "systemError"].includes(p.status?.type))
        this.monitor.child(p.threadId, p.status.type === "active");
      return;
    }
    if (message.id !== undefined) { this.monitor.waiting(); return; } // TUI and structured remote replies share the same request.
    const store = this.monitor.store;
    if (method === "turn/started") { this.turnId = p.turn?.id; this.monitor.begin(); }
    else if (method === "turn/completed") {
      this.turnId = undefined;
      const status = p.turn?.status;
      if (status === "failed") store.state.main.error = p.turn?.error?.message || "Codex run failed";
      this.monitor.end(status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed");
    } else if (method === "thread/status/changed") {
      if (p.status?.type === "active" && (p.status.activeFlags || []).some((s: string) => /waiting/i.test(s))) this.monitor.waiting();
      else if (p.status?.type === "active") {
        if (store.state.main.status === "waiting") store.publish({ ...store.state, main: { ...store.state.main, status: "running" } }, { type: "monitoring.updated" });
      }
    } else if (method === "thread/name/updated") store.dispatch({ type: "session.updated", session: { name: p.threadName || p.name } });
    else if (method === "item/agentMessage/delta") {
      const previous = this.text.get(p.itemId) || "";
      if (!previous) store.dispatch({ type: "assistant.started" });
      this.text.set(p.itemId, (previous + p.delta).slice(-32_000));
      store.dispatch({ type: "assistant.delta", text: p.delta || "" });
    } else if (method === "item/started" || method === "item/completed") {
      const item = p.item || {}, finished = method === "item/completed";
      if (finished && this.completed.has(item.id)) return;
      if (finished) {
        this.completed.add(item.id);
        if (this.completed.size > 1000) this.completed.delete(this.completed.values().next().value!);
      }
      if (item.type === "userMessage" && !finished) {
        const text = (item.content || []).filter((x: any) => x.type === "text").map((x: any) => x.text || "").join("\n");
        if (text) store.dispatch({ type: "user.message", text });
      } else if (item.type === "agentMessage" && finished) {
        store.dispatch({ type: "assistant.completed", text: item.text || this.text.get(item.id) || "" });
        this.text.delete(item.id);
      } else if (item.type === "contextCompaction") {
        store.publish({ ...store.state, commandStatus: finished ? "Context compacted." : "Compacting context…" }, { type: "monitoring.updated" });
      } else if (item.type === "collabAgentToolCall") {
        for (const [id, agent] of Object.entries(item.agentsStates || {}) as [string, any][])
          this.monitor.child(id, ["running", "pendingInit"].includes(agent.status));
        if (!finished && item.tool === "spawnAgent") for (const id of item.receiverThreadIds || []) this.monitor.child(id, true);
      } else if (["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall"].includes(item.type)) {
        if (!finished) store.dispatch({ type: "tool.started", id: item.id, name: item.tool || item.type });
        else store.dispatch({ type: "tool.finished", id: item.id, failed: item.status === "failed" });
      }
    } else if (method === "model/rerouted") store.dispatch({ type: "session.updated", session: { model: p.toModel } });
    this.monitor.activity();
  }
}
