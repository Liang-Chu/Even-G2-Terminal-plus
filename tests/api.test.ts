import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { TestRuntime, completeSession } from "./fixtures/runtime.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { createBridgeServer } from "../apps/windows/src/server.js";

const control = "control-token-for-tests-123456789";
const credential = "notification-token-for-tests-123456789";
test("public static assets cannot follow a directory junction into private files", async t => {
  const root = mkdtempSync(join(tmpdir(), "pilot-static-"));
  const assets = join(root, "assets"), privateDir = join(root, "private");
  mkdirSync(assets); mkdirSync(privateDir);
  writeFileSync(join(assets, "index.html"), "Public page");
  writeFileSync(join(privateDir, "secret.txt"), "private fixture");
  symlinkSync(privateDir, join(assets, "escape"), process.platform === "win32" ? "junction" : "dir");
  const runtime = new TestRuntime({ cwd: root }), journal = new NotificationJournal(runtime.store);
  const bridge = createBridgeServer(runtime, journal, { token: control, notificationToken: credential, staticDir: assets });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  t.after(async () => { await bridge.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}`;
  assert.equal(await (await fetch(origin)).text(), "Public page");
  assert.equal((await fetch(origin + "/escape/secret.txt")).status, 403);
});
const payload = {
  watcher: "Even-Pilot",
  max_length: 80,
  title_max_length: 32,
  expires_after_seconds: 3,
  interval_minutes: 15,
  client: "Glance",
};
test("Glance polls quietly, only consumes settled jobs, persists cursors and scopes credentials", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "even-pilot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new TestRuntime({ cwd: "C:\\work\\Even_PIlot" });
  const journal = new NotificationJournal(
    runtime.store,
    join(dir, "notifications.json"),
  );
  const bridge = createBridgeServer(runtime, journal, {
    token: control,
    notificationToken: credential,
  });
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(async () => {
    await bridge.close();
    journal.close();
  });
  const address = bridge.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const poll = (data = payload, token = credential) =>
    fetch(url + "/api/glance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
  assert.equal((await poll()).status, 204);
  runtime.store.dispatch({ type: "agent.started" });
  assert.equal((await poll()).status, 204);
  runtime.store.dispatch({ type: "agent.settled" }); completeSession(runtime.store);
  const response = await poll();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    title: "Even-Pilot",
    text: "Job complete · Even_PIlot",
  });
  assert.equal((await poll()).status, 204);
  assert.equal(
    (await poll({ ...payload, watcher: "another-phone" })).status,
    200,
  );
  assert.equal((await poll(payload, "wrong")).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/state", {
        headers: { Authorization: `Bearer ${credential}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + "/api/prompt", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + "/api/state", {
        headers: {
          Authorization: `Bearer ${control}`,
          Origin: "https://untrusted.example",
        },
      })
    ).status,
    200, // A QR-paired WebView proves access with its key, not a guessed host origin.
  );
  assert.equal((await poll({ ...payload, max_length: 0 })).status, 400);
  const restored = new NotificationJournal(
    new CockpitStore(""),
    join(dir, "notifications.json"),
  );
  assert.equal(restored.poll(payload.watcher, 80, 32), undefined);
  restored.close();
});
test("notification limits use UTF-16, no duplicate settled and no false success on failed/aborted runs", () => {
  const store = new CockpitStore("C:\\😀😀😀");
  const journal = new NotificationJournal(store);
  store.dispatch({ type: "agent.started" });
  store.dispatch({ type: "assistant.completed", text: "", interrupted: true });
  completeSession(store, "interrupted");
  store.dispatch({ type: "agent.settled" });
  store.dispatch({ type: "agent.settled" });
  assert.equal(journal.list().length, 1);
  assert.equal(journal.list()[0].outcome, "interrupted");
  const short = journal.poll("__proto__", 2, 1)!;
  assert.ok(short.text.length <= 2);
  assert.equal(short.title.length, 1);
  assert.equal(journal.poll("__proto__", 2, 1), undefined);
  store.dispatch({ type: "agent.started" });
  store.dispatch({ type: "runtime.exited", expected: false, error: "crash" });
  assert.equal(journal.list().length, 1, "Connection loss is not completion");
  completeSession(store, "failed");
  assert.equal(journal.list()[1].outcome, "failed");
  journal.close();
});
