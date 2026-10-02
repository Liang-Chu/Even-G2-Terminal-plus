import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../packages/cockpit-state/types.js";
import { reducePiEvent } from "../packages/cockpit-state/reducer.js";
import { statusBar, elapsedTime } from "../packages/cockpit-state/selectors.js";

test("status clock survives snapshots, switches from run to idle only at settled, and excludes tools", () => {
  let state = reducePiEvent(initialState(), { type: "runtime.connected" }, 1_000);
  assert.equal(statusBar(state, true, 43_000).text, "0 AGENTS | IDLE 00:42");
  state = reducePiEvent(state, { type: "agent.started" }, 50_000);
  state = reducePiEvent(state, { type: "tool.started", id: "a", name: "bash" }, 51_000);
  state = reducePiEvent(state, { type: "tool.started", id: "b", name: "read" }, 52_000);
  state = reducePiEvent(state, { type: "assistant.completed", text: "Done" }, 53_000);
  assert.equal(statusBar(JSON.parse(JSON.stringify(state)), true, 92_000).text, "1 AGENT | RUNNING 00:42");
  state = reducePiEvent(state, { type: "agent.settled" }, 95_000);
  assert.equal(statusBar(state, true, 96_000).text, "0 AGENTS | IDLE 00:01");
  state = reducePiEvent(state, { type: "runtime.connected" }, 97_000);
  assert.equal(statusBar(state, true, 99_000).elapsed, "00:04");
  state = reducePiEvent(state, { type: "session.reset" }, 100_000);
  assert.equal(statusBar(state, true, 101_000).elapsed, "00:01");
});

test("offline never reports stale agent counts or ticking runtime time; duration handles hours and clock skew", () => {
  const state = reducePiEvent(reducePiEvent(initialState(), { type: "runtime.connected" }, 0), { type: "agent.started" }, 1000);
  assert.equal(statusBar(state, false, 5000).text, "? AGENTS | OFFLINE --:--");
  assert.equal(statusBar({ ...state, connected: false }, true, 5000).count, undefined);
  assert.equal(elapsedTime(undefined), "--:--");
  assert.equal(elapsedTime(5000, 1000), "00:00");
  assert.equal(elapsedTime(0, 3_661_000), "1:01:01");
});
