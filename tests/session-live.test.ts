import test from "node:test";
import assert from "node:assert/strict";
import { mergeSessionState, monitoringSignature } from "../apps/evenhub/src/sessions/live.js";
import { initialState, type RuntimeState } from "../packages/cockpit-state/types.js";
import type { SessionSummary } from "../apps/evenhub/src/sessions/panel.js";

test("background monitoring changes update cached session rows without changing the selected session", () => {
  const state: RuntimeState = { ...initialState("C:/test"), connected: true, session: { key: "viewed", id: "viewed", cwd: "C:/test" },
    monitoring: { watched: 1, running: 0, since: 0, sessions: [] } };
  let rows: SessionSummary[] = [{ key: "background", id: "saved-id", cwd: "C:/test", name: "Saved title", runtimeStatus: "offline", messageCount: 42 }];
  const before = monitoringSignature(state);
  state.monitoring!.sessions = [{ key: "background", name: "Background", cwd: "C:/test", status: "running", monitored: true, current: false }];
  assert.notEqual(monitoringSignature(state), before);
  rows = mergeSessionState(rows, state);
  assert.equal(rows[0].runtimeStatus, "running"); assert.equal(rows[0].monitored, true); assert.equal(rows[0].messageCount, 42);
  state.monitoring!.sessions[0].status = "idle";
  rows = mergeSessionState(rows, state); assert.equal(rows[0].runtimeStatus, "idle");
  state.monitoring!.sessions = [];
  rows = mergeSessionState(rows, state); assert.equal(rows[0].monitored, false); assert.equal(rows[0].live, false);
  assert.equal(rows[0].name, "Saved title");
});

test("new remote sessions appear immediately and offline membership survives disconnection", () => {
  const state: RuntimeState = { ...initialState("C:/test"), monitoring: { watched: 1, running: 0, since: 0,
    sessions: [{ key: "remote", name: "Remote", cwd: "C:/other", status: "offline", monitored: true, current: false }] } };
  const rows = mergeSessionState([], state);
  assert.equal(rows[0].key, "remote"); assert.equal(rows[0].monitored, true); assert.equal(rows[0].live, false);
  const signature = monitoringSignature(state);
  state.revision++; state.currentAssistantText = "Another streamed token";
  assert.equal(monitoringSignature(state), signature);
});
