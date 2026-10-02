import type { RuntimeState } from "./types.js";
import { G2_SOURCE_TAG } from "./g2-reply.js";

export function toolLabel(state: RuntimeState): string {
  const tools = Object.values(state.tools.active);
  return tools.length === 0
    ? "No active tools"
    : tools.length === 1
      ? tools[0].name
      : `${tools.length} active tools`;
}
export function sessionLabel(state: RuntimeState): string {
  return (
    state.session.name?.trim() ||
    promptLabel(state.transcript.find(entry => entry.role === "user")?.text || "") ||
    state.session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ||
    "New session"
  );
}
/** Keep routing instructions and multiline prompts out of compact session labels. */
export function promptLabel(text: string): string {
  if (text.startsWith(G2_SOURCE_TAG)) {
    const marker = "\n\nUser prompt:\n", start = text.indexOf(marker);
    text = start < 0 ? "" : text.slice(start + marker.length);
  }
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  return characters.length > 80 ? characters.slice(0, 79).join("") + "…" : characters.join("");
}

export function sessionHeader(state: RuntimeState): string {
  const tunnel = state.session.tunnel === "codex" ? "Codex" : state.session.tunnel === "claude" ? "Claude" : "Pi";
  const model = state.session.model?.replace(/^[^/]+\//, "") || "model —";
  return `${tunnel} · ${model} | ${sessionLabel(state)}`;
}
export function elapsedTime(since: number | undefined, now = Date.now()): string {
  if (since === undefined || !Number.isFinite(since)) return "--:--";
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${pad(minutes)}:${pad(seconds % 60)}`
    : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
}

/** Current session only: main Pi plus any independently reported sub-agents. */
export function sessionAgentCount(state: RuntimeState, online: boolean): string {
  if (!online || !state.connected) return "?";
  const main = state.main.status === "running" ? 1 : 0;
  const children = state.subagents?.active;
  if (Number.isSafeInteger(children) && children! >= 0)
    return String((state.subagents?.mainDelegated && children! > 0 ? 0 : main) + children!);
  // A tool name does not reveal its number of children; report a lower bound.
  if (Object.values(state.tools.active).some(tool => /sub.?agent/i.test(tool.name))) return main ? `${main}+` : "?";
  return String(main);
}

/** Counts only the bridge-owned runtime. Tool calls and saved files are not agents. */
export function statusBar(state: RuntimeState, online: boolean, now = Date.now()) {
  if (state.monitoring) {
    const partial = online && state.hosts?.some(host => !host.online);
    const count = online ? state.monitoring.running : undefined;
    const status = !online ? "OFFLINE" : partial ? "PARTIAL" : count ? "RUNNING" : "IDLE";
    const elapsed = online ? elapsedTime(state.monitoring.since, now) : "--:--";
    const agents = `${count ?? "?"}${partial ? "+?" : ""} ${count === 1 && !partial ? "AGENT" : "AGENTS"}`;
    return { status, count, agents, elapsed, text: `${agents} | ${status} ${elapsed}` };
  }
  const ready = online && state.connected;
  const status = ready ? state.main.status.toUpperCase() : "OFFLINE";
  const count = ready ? (state.main.status === "running" ? 1 : 0) : undefined;
  const since = state.main.status === "running" || state.main.status === "waiting"
    ? state.main.startedAt : state.main.statusSince ?? state.main.settledAt;
  const elapsed = ready ? elapsedTime(since, now) : "--:--";
  const agents = `${count ?? "?"} ${count === 1 ? "AGENT" : "AGENTS"}`;
  return { status, count, agents, elapsed, text: `${agents} | ${status} ${elapsed}` };
}

