import type { ServerResponse } from "node:http";
import type { ConnectorMonitor } from "../../../../packages/connectors/monitor.js";
import { claudeQuestions, claudeInteractionQuestions, claudeQuestionAnswers } from "../../../../packages/connectors/claude-questions.js";

export const CLAUDE_QUESTION_TIMEOUT_MS = 5 * 60_000;

/** Only an opted-in connector's own synchronous AskUserQuestion hook waits here.
 * Ordinary global monitor hooks never call this endpoint or return a decision. */
export class ClaudeQuestionRelay {
  private pending = new Map<string, () => void>();
  constructor(private monitor: ConnectorMonitor, private timeout = CLAUDE_QUESTION_TIMEOUT_MS) {}
  handle(event: any, response: ServerResponse) {
    const questions = claudeQuestions(event.question_input), form = questions && claudeInteractionQuestions(questions);
    if (event.hook_event_name !== "PreToolUse" || event.tool_name !== "AskUserQuestion" || event.agent_id
      || event.session_id !== this.monitor.store.state.session.id || !questions || !form
      || typeof event.tool_use_id !== "string" || !/^[\w-]{1,200}$/.test(event.tool_use_id)) return false;
    const source = "claude-question:" + event.tool_use_id;
    if (this.pending.has(source)) return false;
    const instance = this.monitor.snapshot.instance, run = this.monitor.snapshot.runId, key = this.monitor.store.state.session.key;
    let finished = false, remove = () => {}, timer: NodeJS.Timeout;
    const finish = (value = {}) => {
      if (finished) return;
      finished = true; clearTimeout(timer); this.pending.delete(source); remove();
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value));
      }
    };
    this.pending.set(source, finish);
    timer = setTimeout(finish, this.timeout); timer.unref();
    response.once("close", () => finish());
    try {
      remove = this.monitor.interactions.add(source, { kind: "question", title: "Claude needs your input", questions: form, cancelable: true,
        expiresAt: Date.now() + this.timeout }, async answer => {
        if (finished || instance !== this.monitor.snapshot.instance || run !== this.monitor.snapshot.runId
          || key !== this.monitor.store.state.session.key || !this.monitor.store.state.connected) {
          finish(); throw new Error("Claude's current question changed. Answer was not sent.");
        }
        // Explicitly hand the question back to the native CLI. No permission
        // decision, answer or lifecycle transition is invented by cancellation.
        if (answer.cancel) { finish(); return; }
        const answers = claudeQuestionAnswers(questions, answer.answers);
        finish({ answers });
        this.monitor.store.publish({ ...this.monitor.store.state, main: { ...this.monitor.store.state.main, status: "running" } }, { type: "monitoring.updated" });
        this.monitor.activity();
      });
      this.monitor.waiting();
      return true;
    } catch { finish(); return true; }
  }
  cancel() { for (const finish of [...this.pending.values()]) finish(); }
}
