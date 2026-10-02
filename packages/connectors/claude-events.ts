import { connectorKey } from "./identity.js";
import type { ConnectorMonitor } from "./monitor.js";

export class ClaudeEvents {
  constructor(private monitor: ConnectorMonitor) {}
  receive(event: any) {
    if (typeof event.session_id !== "string" || event.session_id !== this.monitor.store.state.session.id) return;
    const store = this.monitor.store;
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
        if (typeof event.agent_id === "string") this.monitor.child(event.agent_id, false); break;
      case "PreToolUse":
        if (store.state.main.status === "waiting") store.publish({ ...store.state, main: { ...store.state.main, status: "running" } }, { type: "monitoring.updated" });
        if (typeof event.tool_use_id === "string") store.dispatch({ type: "tool.started", id: event.tool_use_id, name: event.tool_name || "tool" }); break;
      case "PostToolUse": case "PostToolUseFailure":
        if (typeof event.tool_use_id === "string") store.dispatch({ type: "tool.finished", id: event.tool_use_id, failed: event.hook_event_name === "PostToolUseFailure" }); break;
      case "PermissionRequest": this.monitor.waiting(); break;
      case "Stop":
        if (typeof event.last_assistant_message === "string" && event.last_assistant_message !== store.state.currentAssistantText)
          store.dispatch({ type: "assistant.completed", text: event.last_assistant_message });
        this.monitor.end(); break;
      case "StopFailure": this.monitor.end("failed"); break;
      case "SessionEnd": this.monitor.stop(); break;
    }
    this.monitor.activity();
  }
}
