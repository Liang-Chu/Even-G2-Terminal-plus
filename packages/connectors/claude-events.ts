import { connectorKey } from "./identity.js";
import type { ConnectorMonitor } from "./monitor.js";
const uncertainStop = "Claude completion is uncertain: another Stop hook may continue the work.";

export class ClaudeEvents {
  constructor(private monitor: ConnectorMonitor) {}
  receive(event: any) {
    if (typeof event.session_id !== "string" || event.session_id !== this.monitor.store.state.session.id) return;
    // The parent's session_id is also carried by hooks inside subagents. Their
    // own lifecycle must never stop or restart the parent/main connection.
    if (event.agent_id && ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure"].includes(event.hook_event_name)) return;
    const store = this.monitor.store;
    // Stop's official task registry is parent-scoped, including on
    // SubagentStop. Reconcile it before releasing either busy owner. Older
    // versions omit this field; omission cannot erase known in-flight work.
    if (["Stop", "SubagentStop", "StopFailure"].includes(event.hook_event_name) && event.background_tasks !== undefined) {
      const tasks = event.background_tasks;
      this.monitor.background(Array.isArray(tasks) ? [
        ...tasks.slice(0, 256).map((task: any, index: number) =>
          typeof task?.id === "string" && task.id ? task.id.slice(0, 128) : `unknown:${index}`),
        ...(tasks.length > 256 ? ["unknown:overflow"] : []),
      ] : ["unknown:registry"]);
    }
    if (["Stop", "SubagentStop", "StopFailure"].includes(event.hook_event_name) && event.session_crons !== undefined) {
      const crons = event.session_crons;
      this.monitor.crons(Array.isArray(crons) ? [
        ...crons.slice(0, 256).map((cron: any, index: number) =>
          typeof cron?.id === "string" && cron.id ? cron.id.slice(0, 128) : `unknown:${index}`),
        ...(crons.length > 256 ? ["unknown:overflow"] : []),
      ] : ["unknown:registry"]);
    }
    if (event.model && typeof event.model === "string") store.dispatch({ type: "session.updated", session: { model: event.model } });
    switch (event.hook_event_name) {
      case "SessionStart":
        store.dispatch({ type: "session.updated", session: { key: connectorKey("claude", event.session_id) } }); break;
      case "UserPromptSubmit":
        this.monitor.begin();
        if (typeof event.prompt === "string") store.dispatch({ type: "user.message", text: event.prompt }); break;
      case "SubagentStart":
        if (typeof event.agent_id === "string") this.monitor.child(event.agent_id, true); break;
      case "SubagentStop":
        if (event.stopTrusted === false) { this.uncertainStop(); break; }
        if (typeof event.agent_id === "string") this.monitor.child(event.agent_id, false); break;
      case "PreToolUse":
        // A continued Stop hook or background wakeup can resume the agentic
        // loop without another UserPromptSubmit. Child tools do not resume
        // the main agent: agent_id identifies a subagent in the official API.
        if (typeof event.agent_id !== "string" || !event.agent_id) this.monitor.begin();
        if (store.state.main.status === "waiting") store.publish({ ...store.state, main: { ...store.state.main, status: "running" } }, { type: "monitoring.updated" });
        if (typeof event.tool_use_id === "string") store.dispatch({ type: "tool.started", id: event.tool_use_id, name: event.tool_name || "tool" }); break;
      case "PostToolUse": case "PostToolUseFailure":
        if (typeof event.tool_use_id === "string") store.dispatch({ type: "tool.finished", id: event.tool_use_id, failed: event.hook_event_name === "PostToolUseFailure" }); break;
      case "PermissionRequest": this.monitor.waiting(); break;
      case "Stop":
        if (typeof event.last_assistant_message === "string" && event.last_assistant_message !== store.state.currentAssistantText)
          store.dispatch({ type: "assistant.completed", text: event.last_assistant_message });
        if (event.stopTrusted === false) { this.uncertainStop(); break; }
        if (store.state.commandStatus === uncertainStop)
          store.publish({ ...store.state, commandStatus: undefined }, { type: "monitoring.updated" });
        this.monitor.end(); break;
      case "StopFailure": this.monitor.end("failed"); break;
      case "SessionEnd": this.monitor.stop(); break;
    }
    this.monitor.activity();
  }
  private uncertainStop() {
    const store = this.monitor.store;
    store.publish({ ...store.state, commandStatus: uncertainStop }, { type: "monitoring.updated" });
  }
}
