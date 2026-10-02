import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { UpdateService, parseUpdateRelease, newerVersion, updateRepository } from "../apps/windows/src/updates.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { CockpitStore } from "../packages/cockpit-state/store.js";

const bytes = Buffer.from("verified installer fixture, never executed");
const metadata = () => ({ tag_name: "v2.0.0", draft: false, prerelease: false, assets: [{
  name: "Even-Pilot-2.0.0-Setup-linux-x64.run", state: "uploaded", size: bytes.length,
  digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  browser_download_url: `https://github.com/${updateRepository}/releases/download/v2.0.0/Even-Pilot-2.0.0-Setup-linux-x64.run`,
}] });
function fixture(t: any, override: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pilot-update-"));
  const options = { directory, version: "1.0.22", platform: "linux", arch: "x64", payloadRoot: directory, installRoot: directory,
    port: 4317, automatic: false, supported: true, ...override };
  const service = new UpdateService(options);
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, directory, options };
}
async function until(check: () => boolean) { for (let n = 0; n < 100; n++) { if (check()) return; await delay(10); } throw new Error("Update fixture timeout"); }

test("release comparison and installer selection reject unsafe, incomplete and downgrade metadata", () => {
  assert.equal(newerVersion("1.10.0", "1.9.99"), true);
  assert.equal(newerVersion("1.0.21", "1.0.22"), false);
  assert.equal(newerVersion("1.0.22-beta", "1.0.21"), false);
  assert.equal(parseUpdateRelease(metadata(), "2.0.0", "linux", "x64"), undefined);
  assert.equal(parseUpdateRelease(metadata(), "1.0.22", "linux", "x64")?.version, "2.0.0");
  for (const mutate of [
    (m: any) => { m.prerelease = true; }, (m: any) => { m.draft = true; },
    (m: any) => { m.tag_name = "v2.0.0/../../bad"; }, (m: any) => { m.assets[0].digest = undefined; },
    (m: any) => { m.assets[0].browser_download_url = "https://evil.example/installer.run"; },
    (m: any) => { m.assets.push(m.assets[0]); }, (m: any) => { m.assets[0].size = 300 * 1024 * 1024; },
  ]) { const m = metadata(); mutate(m); assert.throws(() => parseUpdateRelease(m, "1.0.22", "linux", "x64")); }
});

test("automatic checks can be disabled persistently without preventing explicit manual checks", async t => {
  let calls = 0;
  const { service, directory, options } = fixture(t, { fetch: async () => { calls++; return Response.json(metadata()); } });
  service.configure(false);
  assert.equal(JSON.parse(readFileSync(join(directory, "update-settings.json"), "utf8")).automaticChecks, false);
  const restored = new UpdateService(options); t.after(() => restored.close());
  assert.equal(restored.status().automaticChecks, false); assert.equal(calls, 0);
  await restored.check(); assert.equal(calls, 1); assert.equal(restored.status().available?.version, "2.0.0");
  assert.equal(restored.status().automaticChecks, false);
});

test("disabling checks aborts an in-flight check and cannot publish its late result", async t => {
  let complete!: (response: Response) => void;
  const { service } = fixture(t, { fetch: () => new Promise<Response>(done => { complete = done; }) });
  const pending = service.check(); service.configure(false); complete(Response.json(metadata())); await pending;
  assert.equal(service.status().automaticChecks, false); assert.equal(service.status().available, null); assert.equal(service.status().phase, "idle");
});

test("disabled automatic checks make no scheduled requests and re-enabling resumes the daily check", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let calls = 0;
  const { service } = fixture(t, { automatic: true, fetch: async () => { calls++; return Response.json(metadata()); } });
  service.configure(false); t.mock.timers.tick(2 * 24 * 60 * 60_000); assert.equal(calls, 0);
  service.configure(true); t.mock.timers.tick(10_000);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(calls, 1); assert.equal(service.status().available?.version, "2.0.0");
  service.configure(false); t.mock.timers.tick(2 * 24 * 60 * 60_000); assert.equal(calls, 1);
});

test("a verified installer is downloaded once and only explicit install starts it", async t => {
  let installed = 0;
  const { service } = fixture(t, { fetch: async input => String(input).includes("api.github.com") ? Response.json(metadata()) : new Response(bytes),
    install: async path => { assert.deepEqual(readFileSync(path), bytes); installed++; } });
  await Promise.all([service.check(), service.check()]); assert.equal(installed, 0);
  service.install("2.0.0"); assert.throws(() => service.install("2.0.0"));
  await until(() => installed === 1); assert.equal(service.status().progress, 100);
});

test("checksum failure and untrusted redirects never execute an installer", async t => {
  for (const mode of ["corrupt", "redirect", "oversize"]) {
    let installed = false, dangerous = false;
    const { service, directory } = fixture(t, { fetch: async input => {
      if (String(input).includes("api.github.com")) return Response.json(metadata());
      if (String(input).includes("evil.example")) dangerous = true;
      return mode === "redirect" ? new Response(null, { status: 302, headers: { Location: "https://evil.example/file" } })
        : new Response(mode === "corrupt" ? Buffer.alloc(bytes.length) : Buffer.alloc(bytes.length + 1));
    }, install: async () => { installed = true; } });
    await service.check(); service.install("2.0.0"); await until(() => service.status().phase === "idle");
    assert.equal(installed, false); assert.equal(dangerous, false); assert.ok(service.status().error);
    assert.equal(existsSync(join(directory, "updates/installer-2.0.0.run")), false);
  }
});

test("install rechecks the release and refuses source checkouts, stale choices and invalid preferences", async t => {
  let calls = 0, installed = false;
  const { service } = fixture(t, { fetch: async () => { const value = metadata(); if (++calls > 1) value.tag_name = "v3.0.0"; return Response.json(value); },
    install: async () => { installed = true; } });
  assert.throws(() => service.configure("false")); assert.throws(() => service.install("2.0.0"));
  await service.check(); assert.throws(() => service.install("3.0.0"));
  service.install("2.0.0"); await until(() => service.status().phase === "idle"); assert.equal(installed, false);
  const source = fixture(t, { supported: false, fetch: async () => Response.json(metadata()) }).service;
  await source.check(); assert.throws(() => source.install("2.0.0"));
});

test("network failure reports unknown freshness instead of claiming up-to-date", async t => {
  const { service } = fixture(t, { fetch: async () => { throw new Error("secret proxy detail"); } });
  await service.check(); assert.match(service.status().error!, /Cannot reach GitHub/);
  assert.equal(JSON.stringify(service.status()).includes("secret proxy"), false);
});

function pendingJob(directory: string, startedAt: number, workerPid = 900001) {
  mkdirSync(join(directory, "updates"), { recursive: true });
  const job = { id: randomUUID(), version: "2.0.0", startedAt, workerPid, installer: join(directory, "updates/installer-2.0.0.run"), root: directory, directory };
  writeFileSync(join(directory, "updates/job.json"), JSON.stringify(job)); return job;
}

test("a dead update helper recovers after startup grace and permits an explicit retry after backend restart", async t => {
  let now = 1_800_000_000_000, installed = 0;
  const { service, directory, options } = fixture(t, { now: () => now, workerAlive: () => false,
    fetch: async input => String(input).includes("api.github.com") ? Response.json(metadata()) : new Response(bytes),
    install: async () => { installed++; } });
  await service.check(); await service.close();
  const job = pendingJob(directory, now - 5000);
  const restored = new UpdateService(options); t.after(() => restored.close());
  assert.equal(restored.status().phase, "installing", "Startup grace prevents a false failure before the worker starts");
  assert.throws(() => restored.configure(false), /Wait for/);
  now += 11_000;
  const recovered = restored.status();
  assert.equal(recovered.phase, "idle"); assert.match(recovered.error!, /helper stopped/);
  assert.deepEqual(recovered.lastResult, { status: "failed", version: "2.0.0" });
  assert.equal(JSON.parse(readFileSync(join(directory, "update-result.json"), "utf8")).id, job.id);
  assert.equal(existsSync(join(directory, "updates/job.json")), false);
  await restored.check(); restored.install("2.0.0"); await until(() => installed === 1);
  assert.equal(restored.status().phase, "idle", "An explicit retry is available after recovery");
});

test("a live update worker or installer retains the installation lock, even with a stale heartbeat or an unrelated result", async t => {
  for (const running of ["worker", "installer"]) {
    const now = 1_800_000_000_000;
    const { service, directory, options } = fixture(t, { now: () => now,
      workerAlive: pid => running === "worker" ? pid === 900001 : pid === 900002,
      fetch: async () => Response.json(metadata()) });
    await service.check(); await service.close();
    const job = pendingJob(directory, now - 120_000);
    writeFileSync(join(directory, "updates/worker-state.json"), JSON.stringify({ id: job.id, version: job.version, pid: job.workerPid, installerPid: 900002, at: now - 120_000 }));
    writeFileSync(join(directory, "update-result.json"), JSON.stringify({ id: randomUUID(), status: "installed", version: job.version, at: now }));
    const restored = new UpdateService(options); t.after(() => restored.close());
    assert.equal(restored.status().phase, "installing", running + " continues independently of the backend connection");
    assert.throws(() => restored.install("2.0.0"), /already in progress/);
    assert.throws(() => restored.configure(false), /Wait for/);
    await assert.rejects(restored.check(), /already in progress/);
    assert.equal(existsSync(join(directory, "updates/job.json")), true);
  }
});

test("only a matching update generation can report installation completion", async t => {
  const now = 1_800_000_000_000;
  const { service, directory, options } = fixture(t, { now: () => now, workerAlive: () => true });
  await service.close(); const job = pendingJob(directory, now - 1000);
  writeFileSync(join(directory, "update-result.json"), JSON.stringify({ id: randomUUID(), status: "failed", version: job.version, at: now }));
  const restored = new UpdateService(options); t.after(() => restored.close());
  assert.equal(restored.status().phase, "installing"); assert.equal(restored.status().error, null);
  writeFileSync(join(directory, "update-result.json"), JSON.stringify({ id: job.id, status: "installed", version: job.version, at: now }));
  assert.equal(restored.status().phase, "idle");
});

test("detached update helper records its generation and failure without executing a corrupt installer", async t => {
  const { directory, service } = fixture(t); await service.close();
  const job = { ...pendingJob(directory, Date.now()), sha256: "0".repeat(64), port: 4317 };
  writeFileSync(job.installer, bytes); writeFileSync(join(directory, "updates/job.json"), JSON.stringify(job));
  const worker = fileURLToPath(new URL("../apps/windows/src/update-worker.mjs", import.meta.url));
  const child = spawn(process.execPath, [worker, join(directory, "updates/job.json")], { stdio: "ignore", windowsHide: true, shell: false });
  const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("exit", done); });
  assert.equal(code, 0);
  const result = JSON.parse(readFileSync(join(directory, "update-result.json"), "utf8"));
  const state = JSON.parse(readFileSync(join(directory, "updates/worker-state.json"), "utf8"));
  assert.equal(result.id, job.id); assert.equal(result.status, "failed"); assert.equal(state.id, job.id);
  assert.equal(state.pid, child.pid); assert.equal(state.installerPid, undefined);
  assert.equal(existsSync(join(directory, "updates/job.json")), false);
});

test("update preferences and installation require control auth; notification key cannot update", async t => {
  const { service } = fixture(t, { fetch: async () => Response.json(metadata()) });
  const store = new CockpitStore("fixture"), journal = new NotificationJournal(store);
  const bridge = createBridgeServer({ store } as any, journal, { token: "control-test", notificationToken: "notification-test", updates: service });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  t.after(async () => { await bridge.close(); journal.close(); });
  const url = `http://127.0.0.1:${(bridge.server.address() as any).port}`;
  assert.equal((await fetch(url + "/api/updates")).status, 401);
  assert.equal((await fetch(url + "/api/updates", { headers: { Authorization: "Bearer notification-test" } })).status, 403);
  const headers = { Authorization: "Bearer control-test", "Content-Type": "application/json" };
  const result = await fetch(url + "/api/updates/settings", { method: "POST", headers, body: JSON.stringify({ automaticChecks: false }) });
  assert.equal(result.status, 200); assert.equal((await result.json() as any).automaticChecks, false);
  assert.equal((await fetch(url + "/api/updates/install", { method: "POST", headers, body: '{"version":"9.9.9"}' })).status, 409);
});
