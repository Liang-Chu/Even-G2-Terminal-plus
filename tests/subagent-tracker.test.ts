import test from "node:test";
import assert from "node:assert/strict";
import { PiSubagentTracker } from "../packages/pi-runtime/subagent-tracker.js";
import { initialState } from "../packages/cockpit-state/types.js";
import { sessionAgentCount, sessionHeader, sessionLabel } from "../packages/cockpit-state/selectors.js";
import { g2Prompt } from "../packages/cockpit-state/g2-reply.js";
import { boundedAgentTask } from "../packages/cockpit-state/agent-tasks.js";

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

test("Pi activity details keep real worker tasks and remove only the finished parallel worker", () => {
  const tracker = new PiSubagentTracker();
  tracker.update({ type: "tool_execution_start", toolName: "subagent", toolCallId: "parallel", args: {
    tasks: [{ agent: "researcher", task: "Read the project guide" }, { agent: "reviewer", task: "Review the patch" }],
    private_tool_arguments: "PRIVATE-IGNORED",
  } });
  assert.deepEqual(tracker.state?.tasks, [
    { id: "parallel:0", name: "researcher", task: "Read the project guide" },
    { id: "parallel:1", name: "reviewer", task: "Review the patch" },
  ]);
  tracker.update({ type: "tool_execution_update", toolName: "subagent", toolCallId: "parallel", partialResult: { details: { mode: "parallel", results: [
    { exitCode: 0, stopReason: "stop", messages: [{ role: "assistant", content: "PRIVATE-REASONING" }] },
    { exitCode: 0, stopReason: "toolUse", messages: [{ role: "toolResult", content: "PRIVATE-OUTPUT" }] },
  ] } } });
  assert.equal(tracker.state?.active, 1);
  assert.deepEqual(tracker.state?.tasks, [{ id: "parallel:1", name: "reviewer", task: "Review the patch" }]);
  assert.doesNotMatch(JSON.stringify(tracker.state), /PRIVATE/);
  tracker.update({ type: "tool_execution_end", toolCallId: "parallel" }); assert.equal(tracker.state, undefined);
});

test("Pi chain progress shows the explicitly reported current task without changing its single-agent count", () => {
  const tracker = new PiSubagentTracker();
  tracker.update({ type: "tool_execution_start", toolName: "subagent", toolCallId: "chain", args: {
    chain: [{ agent: "scout", task: "Find the code" }, { agent: "worker", task: "Fix the code" }],
  } });
  assert.equal(tracker.state?.tasks?.[0].task, "Find the code");
  tracker.update({ type: "tool_execution_update", toolName: "subagent", toolCallId: "chain", partialResult: { details: {
    mode: "chain", results: [{ agent: "scout", task: "Find the code" }, { agent: "worker", task: "Fix the identified code" }],
  } } });
  assert.equal(tracker.state?.active, 1); assert.equal(tracker.state?.tasks?.[0].name, "worker");
  assert.equal(tracker.state?.tasks?.[0].task, "Fix the identified code");
});

test("long Pi call identifiers keep distinct worker identities across progress and completion", () => {
  const tracker = new PiSubagentTracker(), call = "same-prefix-".repeat(40);
  for (const id of [call, call + "another-call"]) tracker.update({ type: "tool_execution_start", toolName: "subagent", toolCallId: id,
    args: { tasks: [{ agent: "first", task: "First task" }, { agent: "second", task: "Second task" }] } });
  assert.equal(new Set(tracker.state!.tasks!.map(task => task.id)).size, 4);
  assert(tracker.state!.tasks!.every(task => task.id.length <= 128));
  const secondId = tracker.state!.tasks![1].id;
  tracker.update({ type: "tool_execution_update", toolName: "subagent", toolCallId: call, partialResult: { details: {
    mode: "parallel", results: [{ exitCode: 0, stopReason: "stop" }, { exitCode: 0, stopReason: "toolUse" }],
  } } });
  assert.deepEqual(tracker.state!.tasks![0], { id: secondId, name: "second", task: "Second task" });
  assert.equal(tracker.state?.active, 3);
});

test("agent task details have bounded Unicode-safe fields and a capped list without reducing the count", () => {
  const tracker = new PiSubagentTracker(), long = "😀".repeat(300);
  for (let call = 0; call < 3; call++) tracker.update({ type: "tool_execution_start", toolName: "subagent", toolCallId: String(call),
    args: { tasks: Array.from({ length: 8 }, () => ({ agent: long, task: long })) } });
  assert.equal(tracker.state?.active, 24); assert.equal(tracker.state?.tasks?.length, 16); assert.equal(tracker.state?.tasksTruncated, true);
  for (const item of tracker.state!.tasks!) {
    assert.ok(item.name!.length <= 64); assert.ok(item.task!.length <= 256);
    assert.equal(Buffer.from(item.name!).toString("utf8"), item.name); assert.equal(Buffer.from(item.task!).toString("utf8"), item.task);
  }
  const item = boundedAgentTask(long, { name: "worker\n\u0000name", tools: Array.from({ length: 8 }, (_, index) => index + long),
    task: "Read\r\n the\t guide" });
  assert.ok(item.id.length <= 128); assert.equal(item.name, "worker name"); assert.equal(item.task, "Read the guide");
  assert.equal(item.tools?.length, 4); assert(item.tools!.every(tool => tool.length <= 64));
  assert.equal(Buffer.from(item.id).toString("utf8"), item.id);
  tracker.reset(); assert.equal(tracker.state, undefined);
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
