import {
  initialState,
  type NormalizedPiEvent,
  type RuntimeState,
  type TranscriptEntry,
} from "./types.js";

// A bounded recent transcript is shared on reconnect. Pi remains the full-history source.
const MAX_MESSAGES = 200;
const MAX_TEXT = 32_000;
const bound = (text: string) =>
  text.length > MAX_TEXT
    ? "… [earlier text omitted]\n" + text.slice(-MAX_TEXT)
    : text;

export function reducePiEvent(
  state: RuntimeState,
  event: NormalizedPiEvent,
  now = Date.now(),
): RuntimeState {
  let s: RuntimeState = { ...state, revision: state.revision + 1 };
  const append = (entry: Omit<TranscriptEntry, "id" | "at">) => {
    s.transcript = [
      ...s.transcript,
      { ...entry, text: bound(entry.text), id: s.revision, at: now },
    ].slice(-MAX_MESSAGES);
  };
  const finishAssistant = () => {
    if (s.assistantOpen && s.currentAssistantText)
      append({ role: "assistant", text: s.currentAssistantText });
    s.assistantOpen = false;
  };
  switch (event.type) {
    case "runtime.connected":
      s.connected = true;
      s.main = { ...s.main, statusSince: s.main.statusSince ?? now };
      break;
    case "runtime.exited":
      finishAssistant();
      s.connected = false;
      s.tools = { active: {} };
      s.main = {
        ...s.main,
        status: event.expected ? "idle" : "failed",
        statusSince: now,
        error: event.error,
      };
      break;
    case "runtime.failed":
      s.connected = false;
      s.main = { ...s.main, status: "failed", statusSince: now, error: event.error };
      break;
    case "agent.started":
      s.main = { status: "running", statusSince: now, startedAt: now };
      s.currentAssistantText = "";
      s.assistantOpen = false;
      break;
    case "agent.retrying":
      s.main = { ...s.main, status: "running", error: undefined };
      break;
    case "agent.settled":
      finishAssistant();
      s.tools = { active: {} };
      s.main = {
        ...s.main,
        status: s.main.error ? "failed" : "idle",
        statusSince: now,
        settledAt: now,
        outcome: s.main.error
          ? "failed"
          : s.main.outcome === "interrupted"
            ? "interrupted"
            : "completed",
      };
      break;
    case "assistant.started":
      finishAssistant();
      s.currentAssistantText = "";
      s.assistantOpen = true;
      break;
    case "assistant.delta":
      s.currentAssistantText = bound(
        (s.assistantOpen ? s.currentAssistantText : "") + event.text,
      );
      s.assistantOpen = true;
      break;
    case "assistant.completed":
      s.currentAssistantText = bound(event.text);
      s.assistantOpen = true;
      finishAssistant();
      s.main = {
        ...s.main,
        error: event.error,
        outcome: event.interrupted ? "interrupted" : undefined,
      };
      break;
    case "user.message":
      append({ role: "user", text: event.text });
      break;
    case "tool.started":
      s.tools = {
        active: {
          ...s.tools.active,
          [event.id]: { name: event.name, startedAt: now },
        },
      };
      append({
        role: "tool",
        text: event.name,
        toolId: event.id,
        outcome: "running",
      });
      break;
    case "tool.finished": {
      const active = { ...s.tools.active };
      delete active[event.id];
      s.tools = { active };
      s.transcript = s.transcript.map((e) =>
        e.toolId === event.id
          ? { ...e, outcome: event.failed ? "failed" : "completed" }
          : e,
      );
      break;
    }
    case "session.updated":
      s.session = { ...s.session, ...event.session };
      break;
    case "session.history":
      s.transcript = event.transcript.slice(-MAX_MESSAGES).map((entry) => ({ ...entry, text: bound(entry.text) }));
      s.currentAssistantText = s.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text || "";
      s.assistantOpen = false;
      break;
    case "session.reset":
      s = {
        ...initialState(s.session.cwd),
        revision: s.revision,
        connected: s.connected,
        main: { status: "idle", statusSince: now },
      };
      break;
  }
  return s;
}
