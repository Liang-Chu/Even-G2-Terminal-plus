import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../packages/cockpit-state/types.js";
import { reducePiEvent } from "../packages/cockpit-state/reducer.js";
import { normalizePiEvent } from "../packages/pi-runtime/event-normalizer.js";
import {
  statusBar,
  sessionLabel,
  toolLabel,
} from "../packages/cockpit-state/selectors.js";

test("agent_end does not settle, tools tracked by ID, settled clears tools", () => {
  let state = initialState("C:\\project");
  for (const raw of [
    { type: "agent_start" },
    { type: "tool_execution_start", toolCallId: "a", toolName: "bash" },
    { type: "tool_execution_start", toolCallId: "b", toolName: "read" },
    { type: "agent_end" },
  ]) {
    for (const event of normalizePiEvent(raw))
      state = reducePiEvent(state, event);
  }
  assert.equal(state.main.status, "running");
  assert.equal(toolLabel(state), "2 active tools");
  state = reducePiEvent(state, {
    type: "tool.finished",
    id: "a",
    failed: false,
  });
  assert.equal(toolLabel(state), "read");
  state = reducePiEvent(state, { type: "agent.settled" });
  assert.equal(state.main.status, "idle");
  assert.deepEqual(state.tools.active, {});
});
test("deltas arrive immediately, completed content is authoritative, multiple messages stay separate", () => {
  let state = initialState();
  state = reducePiEvent(state, { type: "assistant.delta", text: "Part" });
  assert.equal(state.currentAssistantText, "Part");
  state = reducePiEvent(state, {
    type: "assistant.completed",
    text: "Part one",
  });
  state = reducePiEvent(state, { type: "assistant.started" });
  state = reducePiEvent(state, { type: "assistant.delta", text: "Two" });
  state = reducePiEvent(state, { type: "agent.settled" });
  assert.deepEqual(
    state.transcript.map((x) => x.text),
    ["Part one", "Two"],
  );
});
test("provider failures persist at settled, successful retries clear failure, abort is distinct", () => {
  let state = reducePiEvent(initialState(), { type: "agent.started" });
  state = reducePiEvent(state, {
    type: "assistant.completed",
    text: "",
    error: "quota",
  });
  state = reducePiEvent(state, { type: "agent.settled" });
  assert.equal(state.main.status, "failed");
  state = reducePiEvent(state, { type: "agent.started" });
  state = reducePiEvent(state, { type: "assistant.completed", text: "ok" });
  state = reducePiEvent(state, { type: "agent.settled" });
  assert.equal(state.main.status, "idle");
  assert.equal(state.main.outcome, "completed");
  state = reducePiEvent(state, {
    type: "assistant.completed",
    text: "",
    interrupted: true,
  });
  state = reducePiEvent(state, { type: "agent.settled" });
  assert.equal(state.main.outcome, "interrupted");
});
test("normalizer ignores malformed, thinking and raw tool payloads", () => {
  for (const event of [
    null,
    [],
    "bad",
    { type: "tool_execution_start" },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "private" },
    },
  ]) {
    assert.deepEqual(normalizePiEvent(event), []);
  }
  const event = normalizePiEvent({
    type: "tool_execution_start",
    toolCallId: "1",
    toolName: "bash",
    args: { secret: "value" },
  });
  assert.deepEqual(event, [{ type: "tool.started", id: "1", name: "bash" }]);
});
test("G2 truthfully shows offline and a deterministic tool label", () => {
  const state = initialState("C:\\work\\Even_PIlot");
  assert.match(statusBar(state, false).text, /OFFLINE/);
  assert.match(sessionLabel(state), /Even_PIlot/);
});
