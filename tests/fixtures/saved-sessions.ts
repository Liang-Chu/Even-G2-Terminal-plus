export function savedEntries(cwd: string) {
  return [
    { type: "session", version: 3, id: "saved-session", cwd, timestamp: "2026-01-01T00:00:00Z" },
    { type: "model_change", id: "model", parentId: null, provider: "test", modelId: "fixture" },
    { type: "message", id: "user", parentId: "model", message: { role: "user", content: "Question" } },
    { type: "message", id: "old-branch", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "Abandoned answer" }] } },
    { type: "message", id: "new-branch", parentId: "user", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Selected answer" }] } },
    { type: "message", id: "tool", parentId: "new-branch", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "raw secret tool payload" }] } },
    { type: "session_info", id: "name", parentId: "tool", name: "Saved project" },
  ];
}

