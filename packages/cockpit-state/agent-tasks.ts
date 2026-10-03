import type { RuntimeState } from "./types.js";

export type AgentTask = NonNullable<NonNullable<RuntimeState["subagents"]>["tasks"]>[number];
export const MAX_AGENT_TASKS = 16;

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return;
  if (normalized.length <= limit) return normalized;
  let prefix = normalized.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + "…";
}

/** Project only explicit task metadata; never retain arguments, results or reasoning. */
export function boundedAgentTask(id: string, value: { name?: unknown; task?: unknown; tools?: readonly unknown[] } = {}): AgentTask {
  const name = text(value.name, 64), task = text(value.task, 256);
  const tools = [...new Set((value.tools || []).map(tool => text(tool, 64)).filter((tool): tool is string => !!tool))].slice(0, 4);
  return { id: text(id, 128) || "unknown", ...(name ? { name } : {}), ...(task ? { task } : {}), ...(tools.length ? { tools } : {}) };
}
