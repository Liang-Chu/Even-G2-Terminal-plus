import type { HostSource } from "../../../../packages/cockpit-state/types.js";
import type { SessionSummary } from "./panel.js";

export type SessionScope = "all" | "watched" | "running";
export const deviceKey = (source?: HostSource) => source?.url || source?.id || "local";
export interface SessionGroup { key: string; name: string; online: boolean; sessions: SessionSummary[] }

/** Device identity, not its display name, keeps duplicate session titles apart. */
export function sessionGroups(sessions: SessionSummary[], hosts: HostSource[], filters: {
  device?: string; search?: string; project?: string; scope?: SessionScope;
} = {}): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const host of hosts) groups.set(deviceKey(host), { key: deviceKey(host), name: host.name, online: host.online !== false, sessions: [] });
  const search = filters.search?.trim().toLocaleLowerCase() || "";
  for (const session of sessions) {
    const key = deviceKey(session.source);
    if (!groups.has(key)) groups.set(key, { key, name: session.source?.name || "This computer", online: session.source?.online !== false, sessions: [] });
    if (filters.project && session.cwd !== filters.project || filters.scope === "watched" && !session.monitored ||
      filters.scope === "running" && (session.runtimeStatus !== "running" || !groups.get(key)!.online)) continue;
    if (search && ![session.name, session.preview, session.cwd, session.model, session.tunnel, session.source?.name]
      .some(value => value?.toLocaleLowerCase().includes(search))) continue;
    groups.get(key)!.sessions.push(session);
  }
  return [...groups.values()].filter(group => (!filters.device || group.key === filters.device) &&
    (group.sessions.length || !search && !filters.project && (!filters.scope || filters.scope === "all")))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
    .map(group => ({ ...group, sessions: group.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key)) }));
}

export function sessionAge(at?: number, now = Date.now()): string {
  if (!at) return "Saved";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 1 ? "Now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}
