import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { ConnectionActions } from "../apps/evenhub/src/bridge/connection-actions.js";

test("connection edits remain ordered and a failed verification does not block the next action", async () => {
  const queue = new ConnectionActions(), order: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const failed = queue.run(async () => { order.push("verify"); await hold; throw new Error("Synthetic verification failed"); });
  const next = queue.run(() => { order.push("remove"); return "saved"; });
  await turn(); assert.deepEqual(order, ["verify"]);
  release(); await assert.rejects(failed, /Synthetic verification failed/);
  assert.equal(await next, "saved"); assert.deepEqual(order, ["verify", "remove"]);
});
