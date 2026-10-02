import test from "node:test";
import assert from "node:assert/strict";
import { TestRuntime, completeSession } from "./fixtures/runtime.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { createBridgeServer } from "../apps/windows/src/server.js";

test("SSE reconnect sends current transcript and replays only later completion IDs", async (t) => {
  const runtime = new TestRuntime({ cwd: "test-project" });
  const journal = new NotificationJournal(runtime.store);
  const bridge = createBridgeServer(runtime, journal, {
    token: "control",
    notificationToken: "notifications",
  });
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(async () => {
    await bridge.close();
    journal.close();
  });
  runtime.store.dispatch({ type: "agent.started" });
  runtime.store.dispatch({ type: "assistant.delta", text: "First" });
  runtime.store.dispatch({ type: "agent.settled" }); completeSession(runtime.store);
  runtime.store.dispatch({ type: "agent.started" });
  runtime.store.dispatch({ type: "assistant.delta", text: "Second" });
  runtime.store.dispatch({ type: "agent.settled" }); completeSession(runtime.store);
  const address = bridge.server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
    headers: { Authorization: "Bearer control", "Last-Event-ID": "1" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /event-stream/);
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes("event: completion"))
    text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  assert.match(text, /event: state/);
  assert.match(text, /First/);
  assert.match(text, /Second/);
  assert.match(text, /id: 2/);
  assert.doesNotMatch(text, /id: 1\n/);
});
