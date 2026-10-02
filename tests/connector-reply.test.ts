import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rmdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ConnectorMonitor } from "../packages/connectors/monitor.js";
import { readLocalJson, writeLocalJson } from "../packages/pi-runtime/native-protocol.js";

test("a blocked mailbox acknowledgement is retried without re-executing the delivered prompt", async t => {
  const root = await mkdtemp(join(tmpdir(), "pilot-reply-")); let delivered = 0;
  const monitor = new ConnectorMonitor(root, { key: "fixture", cwd: root }, { prompt: async () => { delivered++; } });
  t.after(async () => {
    monitor.stop(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + "pilot-reply-"));
    await rm(root, { recursive: true, force: true });
  });
  const reply = join(root, monitor.snapshot.instance + ".reply.json");
  const command = join(root, monitor.snapshot.instance + ".command.json");
  await mkdir(reply); // Force atomic replacement failure independent of OS timing.
  writeLocalJson(command, { id: "once", type: "prompt", text: "Synthetic fixture prompt", instance: monitor.snapshot.instance,
    key: "fixture", expiresAt: Date.now() + 5000 });
  await monitor.poll(); assert.equal(delivered, 1);
  await monitor.poll(); assert.equal(delivered, 1);
  await rmdir(reply); await monitor.poll();
  assert.equal(readLocalJson(reply).id, "once"); assert.equal(delivered, 1);
  await monitor.poll(); assert.equal(delivered, 1);
});
