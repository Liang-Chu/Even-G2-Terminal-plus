import type { RuntimeState } from "../cockpit-state/types.js";
import { record } from "./event-normalizer.js";

/** Pi's official subagent example: outstanding delegated tasks, including queued tasks.
 * Its streaming results default exitCode to 0, even while a child is using tools.
 * Only a terminal stopReason/nonzero exit, or the outer tool end, means finished.
 * Unknown extension schemas retain the UI's unknown-count fallback.
 */
export class PiSubagentTracker {
  private calls = new Map<string, number>();
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
          && args.tasks.every(task => typeof record(task)?.agent === "string")) this.calls.set(id, args.tasks.length);
        else if ((Array.isArray(args.chain) && args.chain.length > 0) || typeof args.agent === "string") this.calls.set(id, 1);
      }
      if (event.type === "tool_execution_update") {
        const details = record(record(event.partialResult)?.details);
        if (details?.mode === "parallel" && Array.isArray(details.results) && details.results.length <= 8
          && details.results.every(result => typeof record(result)?.exitCode === "number")) {
          const unfinished = details.results.filter(result => {
            const item = record(result)!;
            return item.exitCode === -1 || (item.exitCode === 0
              && !["stop", "end", "length", "error", "aborted"].includes(String(item.stopReason)));
          }).length;
          this.calls.set(id, unfinished);
        } else if (details?.mode === "single" || details?.mode === "chain") this.calls.set(id, 1);
      }
    }
    return this.state;
  }
  get state(): RuntimeState["subagents"] {
    return this.calls.size ? { active: [...this.calls.values()].reduce((sum, count) => sum + count, 0), mainDelegated: true } : undefined;
  }
}
