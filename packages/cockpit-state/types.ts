export type AgentStatus = "idle" | "running" | "waiting" | "failed";
export type Tunnel = "pi" | "codex" | "claude";
export interface HostSource {
  id: string; name: string; nameSource: "tailscale" | "hostname" | "address"; url?: string; online?: boolean; warning?: string;
  connectionState?: "connecting" | "retrying" | "online" | "offline" | "key-rejected";
  retryAttempt?: number;
}
export interface TranscriptEntry {
  id: number;
  role: "user" | "assistant" | "tool";
  text: string;
  at: number;
  toolId?: string;
  outcome?: "running" | "completed" | "failed";
}
/** Verified pending native input, without question text, choices or tool arguments. */
export interface InputAttention {
  id: string;
  kind: "approval" | "question" | "terminal-input";
  createdAt?: number;
  expiresAt?: number;
  /** Existing observer state is visible, but must not replay a historical alert. */
  baseline?: true;
}
export interface RuntimeState {
  source?: HostSource;
  hosts?: HostSource[];
  nativeTerminals?: boolean;
  revision: number;
  connected: boolean;
  main: {
    status: AgentStatus;
    statusSince?: number;
    startedAt?: number;
    settledAt?: number;
    error?: string;
    outcome?: "completed" | "interrupted" | "failed";
  };
  tools: { active: Record<string, { name: string; startedAt: number }> };
  /** Observed agent activity; uncertainty prevents presenting an exact count. */
  subagents?: { active: number; mainDelegated?: boolean; uncertain?: boolean;
    tasks?: { id: string; name?: string; task?: string; tools?: string[] }[]; tasksTruncated?: boolean };
  session: { id?: string; key?: string; name?: string; cwd: string; model?: string; tunnel?: Tunnel; resumedFrom?: string };
  capabilities?: { interrupt: boolean; prompt?: boolean };
  interactions?: import("./interactions.js").Interaction[];
  attention?: InputAttention[];
  commandStatus?: string;
  currentAssistantText: string;
  assistantOpen: boolean;
  transcript: TranscriptEntry[];
  monitoring?: {
    running: number;
    watched: number;
    since: number;
    sessions: { key: string; name: string; cwd: string; model?: string; tunnel?: Tunnel; source?: HostSource; status: AgentStatus | "offline"; monitored: boolean; current: boolean; updatedAt?: number }[];
  };
}
export type NormalizedPiEvent =
  | { type: "monitoring.updated" }
  | { type: "monitoring.attention"; session: string; sessionId?: string; sessionKey: string; requests: InputAttention[] }
  | { type: "monitoring.settled"; session: string; sessionId?: string; sessionKey?: string; outcome: "completed" | "failed" | "interrupted" }
  | { type: "runtime.connected" }
  | { type: "runtime.exited"; expected: boolean; error?: string }
  | { type: "runtime.failed"; error: string }
  | { type: "agent.started" }
  | { type: "agent.settled" }
  | { type: "agent.retrying" }
  | { type: "assistant.started" }
  | { type: "assistant.delta"; text: string }
  | {
      type: "assistant.completed";
      text: string;
      error?: string;
      interrupted?: boolean;
    }
  | { type: "user.message"; text: string }
  | { type: "tool.started"; id: string; name: string }
  | { type: "tool.finished"; id: string; failed: boolean }
  | { type: "session.updated"; session: Partial<RuntimeState["session"]> }
  | { type: "session.history"; transcript: TranscriptEntry[] }
  | { type: "session.reset" };

export function initialState(cwd = ""): RuntimeState {
  return {
    revision: 0,
    connected: false,
    main: { status: "idle" },
    tools: { active: {} },
    session: { cwd },
    currentAssistantText: "",
    assistantOpen: false,
    transcript: [],
  };
}
