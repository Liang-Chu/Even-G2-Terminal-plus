import test from "node:test";
import assert from "node:assert/strict";
import { TapGestures } from "../apps/evenhub/src/g2/tap-gestures.js";

test("native single/double dispatch immediately without a synthetic combination or timer", t => {
  let now = 10_000; t.mock.method(Date, "now", () => now);
  const actions: string[] = [];
  const gestures = new TapGestures({ single: () => actions.push("single"), double: () => actions.push("double") });
  gestures.input(0); assert.deepEqual(actions, ["single"]);
  now += 200; gestures.input(3); assert.deepEqual(actions, ["single", "double"]);
  now += 200; gestures.input(0); now += 200; gestures.input(0);
  assert.deepEqual(actions, ["single", "double", "single", "single"]);
});

test("duplicate envelopes cannot leak across a page change even if its callback resets gestures", t => {
  let now = 10_000; t.mock.method(Date, "now", () => now);
  const actions: string[] = [];
  const gestures = new TapGestures({ single: () => { gestures.reset(); actions.push("open"); }, double: () => actions.push("back") });
  gestures.input(0); gestures.input(0); now += 99; gestures.input(0);
  assert.deepEqual(actions, ["open"]);
  now += 2; gestures.input(3); gestures.input(3); assert.deepEqual(actions, ["open", "back"]);
});
