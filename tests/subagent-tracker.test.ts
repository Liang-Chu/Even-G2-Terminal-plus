import test from "node:test";
import assert from "node:assert/strict";
import { PiSubagentTracker } from "../packages/pi-runtime/subagent-tracker.js";
import { initialState } from "../packages/cockpit-state/types.js";
import { sessionAgentCount, sessionHeader, sessionLabel } from "../packages/cockpit-state/selectors.js";
import { g2Prompt } from "../packages/cockpit-state/g2-reply.js";

test("official Pi parallel updates keep streaming exitCode 0 children active; parent waiting is not counted twice", () => {
  const tracker = new PiSubagentTracker();
  const state = { ...initialState(), connected: true, main: { status: "running" as const } };
  const update = (event: object) => sessionAgentCount({ ...state, subagents: tracker.update(event) }, true);
  assert.equal(update({ type: "tool_execution_start", toolName: "subagent", toolCallId: "parallel",
    args: { tasks: Array.from({ length: 3 }, () => ({ agent: "worker", task: "sleep 60" })) } }), "3");
  const results = Array.from({ length: 3 }, () => ({ exitCode: 0, stopReason: "toolUse", messages: [{ role: "toolResult" }] }));
  const progress = () => ({ type: "tool_execution_update", toolName: "subagent", toolCallId: "parallel", partialResult: { details: { mode: "parallel", results } } });
  assert.equal(update(progress()), "3", "the official extension sets exitCode 0 before process exit");
  results[0].stopReason = "stop";
  assert.equal(update(progress()), "2");
  results[1].exitCode = 1;
  assert.equal(update(progress()), "1");
  results[2].stopReason = "stop";
  assert.equal(update(progress()), "1", "zero children returns ownership to the still-running main before the tool end event");
  assert.equal(sessionAgentCount({ ...state, subagents: tracker.state }, false), "?");
  assert.equal(update({ type: "tool_execution_end", toolCallId: "parallel" }), "1", "main continues its response");
  tracker.update({ type: "agent_settled" });
  assert.equal(sessionAgentCount({ ...state, main: { status: "idle" }, subagents: tracker.state }, true), "0");
});

test("Pi serial chains count one, tool calls are independent, cancellation/reset clear counts and unknown schemas remain unknown", () => {
  const tracker = new PiSubagentTracker();
  assert.equal(tracker.update({ type: "tool_execution_start", toolName: "bash", toolCallId: "bash" }), undefined);
  assert.equal(tracker.update({ type: "tool_execution_start", toolName: "subagent", toolCallId: "unknown", args: {} }), undefined);
  const state = { ...initialState(), connected: true, main: { status: "running" as const }, tools: { active: { unknown: { name: "subagent", startedAt: 1 } } } };
  assert.equal(sessionAgentCount(state, true), "1+");
  tracker.update({ type: "tool_execution_start", toolName: "subagent", toolCallId: "chain", args: { chain: [{ agent: "a" }, { agent: "b" }] } });
  assert.equal(tracker.state?.active, 1);
  tracker.update({ type: "tool_execution_start", toolName: "subagent", toolCallId: "single", args: { agent: "a" } });
  assert.equal(tracker.state?.active, 2);
  tracker.update({ type: "tool_execution_end", toolCallId: "chain", isError: true });
  assert.equal(tracker.state?.active, 1);
  tracker.update({ type: "agent_settled" }); assert.equal(tracker.state, undefined);
});

test("G2 header includes tunnel/model and notification labels prefer titles over paths or routing wrappers", () => {
  const state = initialState("C:/work/my-project");
  state.session = { cwd: state.session.cwd, tunnel: "codex", model: "openai/gpt-5.4", name: "Repair sign-in" };
  assert.equal(sessionHeader(state), "Codex · gpt-5.4 | Repair sign-in");
  state.transcript = [{ id: 1, role: "user", text: g2Prompt("修复登录\n然后跑测试"), at: 1 }];
  assert.equal(sessionLabel(state), "Repair sign-in");
  state.session.name = undefined;
  assert.equal(sessionLabel(state), "修复登录 然后跑测试");
  state.transcript = [];
  assert.equal(sessionLabel(state), "my-project");
});
