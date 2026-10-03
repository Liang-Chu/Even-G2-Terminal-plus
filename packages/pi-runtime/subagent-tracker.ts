import type { RuntimeState } from "../cockpit-state/types.js";
import { record } from "./event-normalizer.js";
import { boundedAgentTask, MAX_AGENT_TASKS, type AgentTask } from "../cockpit-state/agent-tasks.js";
import { createHash } from "node:crypto";

interface Call { active: number; tasks: AgentTask[] }
const taskId = (call: string, index: number) => call.length + String(index).length + 1 <= 128 ? `${call}:${index}`
  : `call:${createHash("sha256").update(call).digest("hex")}:${index}`;
const task = (id: string, value: unknown) => { const item = record(value); return boundedAgentTask(id, { name: item?.agent, task: item?.task }); };

/** Pi's official subagent example: outstanding delegated tasks, including queued tasks.
 * Its streaming results default exitCode to 0, even while a child is using tools.
 * Only a terminal stopReason/nonzero exit, or the outer tool end, means finished.
 * Unknown extension schemas retain the UI's unknown-count fallback.
 */
export class PiSubagentTracker {
  private calls = new Map<string, Call>();
  reset() { this.calls.clear(); }
  update(value: unknown): RuntimeState["subagents"] {
    const event = record(value);
    if (!event) return this.state;
    if (["agent_start", "agent_settled", "session_shutdown"].includes(String(event.type))) this.reset();
    const id = event.toolCallId;
    if (typeof id !== "string") return this.state;
    if (event.type === "tool_execution_end") this.calls.delete(id);
    else if (event.toolName === "subagent") {
      const args = record(event.args);
      if (event.type === "tool_execution_start" && args) {
        if (Array.isArray(args.tasks) && args.tasks.length > 0 && args.tasks.length <= 8
          && args.tasks.every(task => typeof record(task)?.agent === "string")) this.calls.set(id,
            { active: args.tasks.length, tasks: args.tasks.map((item, index) => task(taskId(id, index), item)) });
        else if ((Array.isArray(args.chain) && args.chain.length > 0) || typeof args.agent === "string") this.calls.set(id,
          { active: 1, tasks: [task(taskId(id, 0), typeof args.agent === "string" ? args : Array.isArray(args.chain) ? args.chain[0] : undefined)] });
      }
      if (event.type === "tool_execution_update") {
        const details = record(record(event.partialResult)?.details);
        if (details?.mode === "parallel" && Array.isArray(details.results) && details.results.length <= 8
          && details.results.every(result => typeof record(result)?.exitCode === "number")) {
          const previous = this.calls.get(id);
          const unfinished = details.results.flatMap((result, index) => {
            const item = record(result)!;
            const active = item.exitCode === -1 || (item.exitCode === 0
              && !["stop", "end", "length", "error", "aborted"].includes(String(item.stopReason)));
            if (!active) return [];
            const childId = taskId(id, index), earlier = previous?.tasks.find(value => value.id === childId);
            return [boundedAgentTask(childId, { name: typeof item.agent === "string" ? item.agent : earlier?.name,
              task: typeof item.task === "string" ? item.task : earlier?.task })];
          });
          this.calls.set(id, { active: unfinished.length, tasks: unfinished });
        } else if (details?.mode === "single" || details?.mode === "chain") {
          const latest = Array.isArray(details.results) ? details.results.at(-1) : undefined;
          const previous = this.calls.get(id);
          this.calls.set(id, { active: 1, tasks: latest ? [task(taskId(id, 0), latest)] : previous?.tasks || [boundedAgentTask(taskId(id, 0))] });
        }
      }
    }
    return this.state;
  }
  get state(): RuntimeState["subagents"] {
    if (!this.calls.size) return;
    const calls = [...this.calls.values()], active = calls.reduce((sum, call) => sum + call.active, 0);
    const tasks = calls.flatMap(call => call.tasks).slice(0, MAX_AGENT_TASKS);
    return { active, mainDelegated: true, tasks, ...(active > tasks.length ? { tasksTruncated: true } : {}) };
  }
}
