import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInfo, tailscaleName } from "../apps/windows/src/host-info.js";

test("host name uses the Tailscale device DNS label and never exposes tailnet peers", async t => {
  const root = await mkdtemp(join(tmpdir(), "pilot-host-info-")); t.after(() => rm(root, { recursive: true, force: true }));
  let reads = 0;
  const read = hostInfo(root, async () => { reads++; return { Self: { DNSName: "nuc.example.ts.net.", HostName: "linux-original" }, Peer: { private: "not exposed" } }; }, "fallback");
  const value = await read();
  assert.equal(value.name, "nuc"); assert.equal(value.nameSource, "tailscale");
  assert(!JSON.stringify(value).includes("example.ts.net")); assert(!JSON.stringify(value).includes("not exposed"));
  assert.deepEqual(await read(), value); assert.equal(reads, 1);
  const fallback = await hostInfo(root, async () => { throw new Error("not installed"); }, "my-computer")();
  assert.equal(fallback.id, value.id); assert.equal(fallback.nameSource, "hostname");
  assert.equal(fallback.name, "my-computer"); assert.match(fallback.warning!, /Tailscale.*unavailable/);
  assert.equal(tailscaleName({ Self: { DNSName: "bad\nname" } }), undefined);
});
