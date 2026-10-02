import type { NormalizedPiEvent } from "../cockpit-state/types.js";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value
        .map(record)
        .filter((x) => x?.type === "text" && typeof x.text === "string")
        .map((x) => x!.text)
        .join("\n")
    : "";
}
export function normalizePiEvent(value: unknown): NormalizedPiEvent[] {
  const e = record(value);
  if (!e) return [];
  const message = record(e.message);
  switch (e.type) {
    case "agent_start":
      return [{ type: "agent.started" }];
    case "agent_settled":
      return [{ type: "agent.settled" }];
    case "auto_retry_start":
      return [{ type: "agent.retrying" }];
    // agent_end intentionally does not change runtime status.
    case "message_start":
      if (message?.role === "assistant") return [{ type: "assistant.started" }];
      if (message?.role === "user")
        return [{ type: "user.message", text: messageText(message.content) }];
      return [];
    case "message_update": {
      const delta = record(e.assistantMessageEvent);
      return delta?.type === "text_delta" && typeof delta.delta === "string"
        ? [{ type: "assistant.delta", text: delta.delta }]
        : [];
    }
    case "message_end":
      return message?.role === "assistant"
        ? [
            {
              type: "assistant.completed",
              text: messageText(message.content),
              error:
                message.stopReason === "error"
                  ? String(message.errorMessage || "Pi provider failed")
                  : undefined,
              interrupted: message.stopReason === "aborted",
            },
          ]
        : [];
    case "tool_execution_start":
      return typeof e.toolCallId === "string" && typeof e.toolName === "string"
        ? [{ type: "tool.started", id: e.toolCallId, name: e.toolName }]
        : [];
    case "tool_execution_end":
      return typeof e.toolCallId === "string"
        ? [
            {
              type: "tool.finished",
              id: e.toolCallId,
              failed: e.isError === true,
            },
          ]
        : [];
    default:
      return [];
  }
}
