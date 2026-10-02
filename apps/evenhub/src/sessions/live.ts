import type { RuntimeState } from "../../../../packages/cockpit-state/types.js";
import type { SessionSummary } from "./panel.js";

export function monitoringSignature(state: RuntimeState): string {
  return JSON.stringify(state.monitoring?.sessions.map(s => [s.key, s.name, s.cwd, s.model, s.tunnel, s.source, s.status, s.monitored, s.current, s.updatedAt]) || []);
}

/** SSE is authoritative for live membership; saved-history metadata can stay cached. */
export function mergeSessionState(saved: SessionSummary[], state: RuntimeState): SessionSummary[] {
  if (!state.monitoring) return saved;
  const remaining = new Map(state.monitoring.sessions.map(s => [s.key, s]));
  const result: SessionSummary[] = saved.map(session => {
    const live = remaining.get(session.key); remaining.delete(session.key);
    if (!live) return { ...session, live: false, monitored: false, runtimeStatus: "offline" as const };
    return { ...session, name: session.name || live.name, cwd: live.cwd, model: live.model || session.model,
      tunnel: live.tunnel || session.tunnel, source: live.source || session.source, monitored: live.monitored,
      updatedAt: Math.max(session.updatedAt || 0, live.updatedAt || 0), live: live.status !== "offline", runtimeStatus: live.status };
  });
  for (const live of remaining.values()) result.push({ key: live.key,
    id: live.key === state.session.key ? state.session.id || live.key : live.key,
    name: live.name, cwd: live.cwd, model: live.model, tunnel: live.tunnel, source: live.source,
    updatedAt: live.updatedAt, monitored: live.monitored, live: live.status !== "offline", runtimeStatus: live.status });
  return result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
}
