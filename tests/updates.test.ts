import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, unlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { UpdateService, parseUpdateRelease, newerVersion, updateRepository } from "../apps/windows/src/updates.js";
import { createBridgeServer } from "../apps/windows/src/server.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { windowsUpdateFetch } from "../apps/windows/src/update-fetch.js";

const bytes = Buffer.from("verified installer fixture, never executed");
const metadata = () => ({ tag_name: "v2.0.0", draft: false, prerelease: false, assets: [{
  name: "Terminal-plus-2.0.0-Setup-linux-x64.run", state: "uploaded", size: bytes.length,
  digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  browser_download_url: `https://github.com/${updateRepository}/releases/download/v2.0.0/Terminal-plus-2.0.0-Setup-linux-x64.run`,
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
async function flushAsync(check: () => boolean) { for (let n = 0; n < 10_000; n++) { if (check()) return; await new Promise<void>(done => setImmediate(done)); } throw new Error("Scheduled update fixture timeout"); }
function releaseMetadata(version = "2.0.0", platform = "linux") {
  const value = metadata(), name = platform === "win32" ? `Terminal-plus-${version}-Setup-x64.exe` : `Terminal-plus-${version}-Setup-linux-x64.run`;
  value.tag_name = "v" + version; value.assets[0].name = name;
  value.assets[0].browser_download_url = `https://github.com/${updateRepository}/releases/download/v${version}/${name}`;
  return value;
}

// A generated, local-only certificate avoids external services or changes to
// the machine's trust store. Only fixture requests receive this private CA.
function localCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = (tag: number, ...parts: Buffer[]) => {
    const content = Buffer.concat(parts), length = content.length;
    const size = length < 128 ? Buffer.from([length]) : length < 256 ? Buffer.from([0x81, length]) : Buffer.from([0x82, length >> 8, length & 255]);
    return Buffer.concat([Buffer.from([tag]), size, content]);
  };
  const seq = (...parts: Buffer[]) => der(0x30, ...parts);
  const algorithm = seq(der(6, Buffer.from("2a864886f70d01010b", "hex")), der(5));
  const name = seq(der(0x31, seq(der(6, Buffer.from("550403", "hex")), der(0x0c, Buffer.from("localhost")))));
  const date = (offset: number) => der(0x18, Buffer.from(new Date(Date.now() + offset).toISOString().replace(/[-:T]/g, "").replace(/\.\d+Z/, "Z")));
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    seq(date(-86400_000), date(86400_000)), name, publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(seq(der(6, Buffer.from("551d11", "hex")), der(4, seq(der(0x82, Buffer.from("localhost"))))),
      seq(der(6, Buffer.from("551d13", "hex")), der(4, seq(der(1, Buffer.from([255]))))))));
  const certificate = seq(tbs, algorithm, der(3, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: "-----BEGIN CERTIFICATE-----\n" + certificate.toString("base64").match(/.{1,64}/g)!.join("\n") + "\n-----END CERTIFICATE-----\n" };
}
async function httpsFixture(t: any, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const credentials = localCertificate(), server = createHttpsServer(credentials, handler);
  server.on("tlsClientError", () => {});
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const url = `https://localhost:${(server.address() as any).port}`;
  const request: NonNullable<Parameters<typeof windowsUpdateFetch>[2]> = (target, options, receive) =>
    httpsRequest(target, { ...options, ca: credentials.cert }, receive);
  return { url, request, cert: credentials.cert };
}

test("Windows update HTTPS streams data with explicit family resolution and unchanged TLS identity", async t => {
  const f = await httpsFixture(t, (_request, response) => { response.setHeader("X-Fixture", "streamed"); response.write("first"); response.end("second"); });
  let requested: any;
  const response = await windowsUpdateFetch(f.url, { redirect: "manual" }, (url, options, receive) => {
    requested = { hostname: url.hostname, ...options }; return f.request(url, options, receive);
  });
  assert.equal(requested.hostname, "localhost"); assert.equal(requested.servername, "localhost");
  assert.equal(requested.family, 4); assert.equal(requested.rejectUnauthorized, true);
  assert.equal(requested.lookup, undefined, "No pinned address replaces normal DNS");
  assert.equal(response.headers.get("x-fixture"), "streamed");
  assert.equal(await response.text(), "firstsecond");
});

test("Windows update HTTPS rejects untrusted and mismatched certificates without a retry", async t => {
  const f = await httpsFixture(t, (_request, response) => response.end("must not be accepted"));
  let requests = 0;
  await assert.rejects(windowsUpdateFetch(f.url, {}, (url, options, receive) => {
    requests++; return httpsRequest(url, options, receive);
  }), (error: any) => error.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(windowsUpdateFetch(f.url.replace("localhost", "wrong.test"), {}, (url, options, receive) => {
    requests++; return httpsRequest(url, { ...options, ca: f.cert, lookup: (_host, _options, done) => done(null, "127.0.0.1", 4) }, receive);
  }), (error: any) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID");
  assert.equal(requests, 1);
});

test("Windows update HTTPS leaves redirects to the updater and rejects metadata redirects", async t => {
  let requests = 0;
  const f = await httpsFixture(t, (_request, response) => { requests++; response.writeHead(302, { Location: "https://evil.example/installer" }); response.end(); });
  const response = await windowsUpdateFetch(f.url, { redirect: "manual" }, f.request);
  assert.equal(response.status, 302); assert.equal(response.headers.get("location"), "https://evil.example/installer");
  await response.body?.cancel(); assert.equal(requests, 1, "The transport never follows an unchecked destination");
  await assert.rejects(windowsUpdateFetch(f.url, { redirect: "error" }, f.request), /redirect was rejected/);
  assert.equal(requests, 2);
});

test("Windows update HTTPS cancels active bodies and releases their server connections", async t => {
  let closed = 0;
  const f = await httpsFixture(t, (_request, response) => { response.on("close", () => closed++); response.write("chunk"); });
  const cancelled = await windowsUpdateFetch(f.url, {}, f.request);
  await cancelled.body!.cancel(); await until(() => closed === 1);
  const controller = new AbortController(), aborted = await windowsUpdateFetch(f.url, { signal: controller.signal }, f.request);
  const reader = aborted.body!.getReader(); assert.equal((await reader.read()).done, false);
  controller.abort(); await assert.rejects(reader.read()); await until(() => closed === 2);
});

test("Windows update HTTPS aborts before headers without leaving a connection or retry", async t => {
  let entered = false, closed = false, requests = 0;
  const f = await httpsFixture(t, (_request, response) => { entered = true; response.on("close", () => { closed = true; }); });
  const controller = new AbortController();
  const pending = windowsUpdateFetch(f.url, { signal: controller.signal }, (url, options, receive) => { requests++; return f.request(url, options, receive); });
  const rejected = assert.rejects(pending, (error: any) => error.name === "AbortError");
  await until(() => entered); controller.abort(); await rejected; await until(() => closed);
  assert.equal(requests, 1);
});

test("Windows update HTTPS retries IPv6 only for an unavailable IPv4 route", async t => {
  const f = await httpsFixture(t, (_request, response) => response.end("available"));
  const families: (number | undefined)[] = [];
  const response = await windowsUpdateFetch(f.url, {}, (url, options, receive) => {
    families.push(options.family);
    if (options.family === 4) {
      const unavailable = new EventEmitter() as ClientRequest;
      unavailable.end = (() => { queueMicrotask(() => unavailable.emit("error", Object.assign(new Error("No IPv4 route"), { code: "ENETUNREACH" }))); return unavailable; }) as ClientRequest["end"];
      return unavailable;
    }
    // Simulate a working alternate family on this loopback fixture.
    return f.request(url, { ...options, family: 4 }, receive);
  });
  assert.deepEqual(families, [4, 6]); assert.equal(await response.text(), "available");
});

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
  const { service } = fixture(t, { automatic: true, supported: false, fetch: async () => { calls++; return Response.json(metadata()); } });
  service.configure(false); t.mock.timers.tick(2 * 24 * 60 * 60_000); assert.equal(calls, 0);
  service.configure(true); t.mock.timers.tick(10_000);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(calls, 1); assert.equal(service.status().available?.version, "2.0.0");
  service.configure(false); t.mock.timers.tick(2 * 24 * 60 * 60_000); assert.equal(calls, 1);
});

test("default-enabled scheduled updates verify and install eligible Windows and Linux packages without a manual click", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  for (const platform of ["win32", "linux"]) {
    let installed = 0, checks = 0, downloads = 0;
    const { service, directory } = fixture(t, { automatic: true, platform, fetch: async input => {
      if (String(input).includes("api.github.com")) { checks++; return Response.json(releaseMetadata("2.0.0", platform)); }
      downloads++; return new Response(bytes);
    }, install: async (path, release) => {
      assert.deepEqual(readFileSync(path), bytes); assert.equal(release.version, "2.0.0");
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "update-settings.json"), "utf8")).automaticAttempt,
        { version: "2.0.0", at: Date.now() });
      installed++;
    } });
    assert.equal(service.status().automaticChecks, true); assert.equal(checks, 0);
    t.mock.timers.tick(10_000);
    await flushAsync(() => installed === 1 && service.status().phase === "idle");
    assert.equal(checks, 2, "check and install each fetch fresh release metadata"); assert.equal(downloads, 1);
    t.mock.timers.tick(60 * 60_000); await new Promise<void>(done => setImmediate(done));
    assert.equal(installed, 1, "the completed attempt is not repeated between daily checks");
    await service.close();
  }
});

test("scheduled checks never download or install into source checkouts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let checks = 0, downloads = 0, installed = 0;
  const { service } = fixture(t, { automatic: true, supported: false, fetch: async input => {
    if (String(input).includes("api.github.com")) { checks++; return Response.json(metadata()); }
    downloads++; return new Response(bytes);
  }, install: async () => { installed++; } });
  t.mock.timers.tick(10_000); await flushAsync(() => service.status().available !== null && service.status().phase === "idle");
  await new Promise<void>(done => setImmediate(done));
  assert.equal(checks, 1); assert.equal(downloads, 0); assert.equal(installed, 0);
});

test("opting out during a scheduled check prevents a late response from starting automatic installation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let complete!: (response: Response) => void, calls = 0, installed = 0;
  const { service, options } = fixture(t, { automatic: true,
    fetch: () => { calls++; return new Promise<Response>(done => { complete = done; }); }, install: async () => { installed++; } });
  t.mock.timers.tick(10_000); assert.equal(calls, 1);
  service.configure(false); complete(Response.json(metadata()));
  await new Promise<void>(done => setImmediate(done));
  assert.equal(service.status().available, null); assert.equal(installed, 0);
  await service.close();
  const restored = new UpdateService(options); t.after(() => restored.close());
  assert.equal(restored.status().automaticChecks, false);
  t.mock.timers.tick(2 * 24 * 60 * 60_000); assert.equal(calls, 1); assert.equal(installed, 0);
});

test("automatic failure cooldown survives restart, blocks same-release retries, and permits a verified manual retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let installed = 0, downloads = 0, corrupt = true;
  const { service, directory, options } = fixture(t, { automatic: true, fetch: async input => {
    if (String(input).includes("api.github.com")) return Response.json(metadata());
    downloads++; return new Response(corrupt ? Buffer.alloc(bytes.length) : bytes);
  }, install: async path => { assert.deepEqual(readFileSync(path), bytes); installed++; } });
  t.mock.timers.tick(10_000); await flushAsync(() => service.status().error !== null && service.status().phase === "idle");
  await service.close();
  assert.equal(installed, 0); assert.equal(downloads, 1);
  const saved = JSON.parse(readFileSync(join(directory, "update-settings.json"), "utf8"));
  assert.equal(saved.automaticAttempt.version, "2.0.0");
  saved.checkedAt = Date.now() - 24 * 60 * 60_000;
  writeFileSync(join(directory, "update-settings.json"), JSON.stringify(saved));
  const restored = new UpdateService(options); t.after(() => restored.close());
  t.mock.timers.tick(10_000); await flushAsync(() => restored.status().checkedAt === Date.now());
  await new Promise<void>(done => setImmediate(done));
  assert.equal(downloads, 1, "restart and a fresh check cannot bypass the persisted cooldown");
  corrupt = false;
  await restored.check(); restored.install("2.0.0"); await flushAsync(() => installed === 1 && restored.status().phase === "idle");
  assert.equal(downloads, 2, "an explicit retry still uses the verified pipeline");
});

test("a different newer release remains eligible during the previous release's automatic retry cooldown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let version = "2.0.0", installedVersion = "", downloads = 0;
  const { service, directory, options } = fixture(t, { automatic: true, fetch: async input => {
    if (String(input).includes("api.github.com")) return Response.json(releaseMetadata(version));
    downloads++; return new Response(version === "2.0.0" ? Buffer.alloc(bytes.length) : bytes);
  }, install: async (_path, release) => { installedVersion = release.version; } });
  t.mock.timers.tick(10_000); await flushAsync(() => service.status().error !== null); await service.close();
  const saved = JSON.parse(readFileSync(join(directory, "update-settings.json"), "utf8"));
  saved.checkedAt = Date.now() - 24 * 60 * 60_000;
  writeFileSync(join(directory, "update-settings.json"), JSON.stringify(saved));
  version = "2.0.1";
  const restored = new UpdateService(options); t.after(() => restored.close());
  t.mock.timers.tick(10_000); await flushAsync(() => installedVersion === "2.0.1" && restored.status().phase === "idle");
  assert.equal(downloads, 2);
});

test("automatic same-release retry waits for the daily cooldown instead of looping after failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let installed = 0, downloads = 0, corrupt = true;
  const { service } = fixture(t, { automatic: true, fetch: async input => {
    if (String(input).includes("api.github.com")) return Response.json(metadata());
    downloads++; return new Response(corrupt ? Buffer.alloc(bytes.length) : bytes);
  }, install: async () => { installed++; } });
  t.mock.timers.tick(10_000); await flushAsync(() => service.status().error !== null && service.status().phase === "idle" && !(service as any).task);
  t.mock.timers.tick(23 * 60 * 60_000); await new Promise<void>(done => setImmediate(done));
  assert.equal(downloads, 1); assert.equal(installed, 0);
  corrupt = false;
  t.mock.timers.tick(60 * 60_000); await flushAsync(() => installed === 1 && service.status().phase === "idle");
  assert.equal(downloads, 2);
});

test("an automatic attempt cannot download until its cooldown and preference have been durably saved", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let metadataCalls = 0, downloads = 0, installed = 0;
  const { service, directory } = fixture(t, { automatic: true, fetch: async input => {
    if (String(input).includes("api.github.com")) { metadataCalls++; return Response.json(metadata()); }
    downloads++; return new Response(bytes);
  }, install: async () => { installed++; } });
  mkdirSync(join(directory, "update-settings.json.tmp"));
  t.mock.timers.tick(10_000); await flushAsync(() => service.status().error !== null && service.status().phase === "idle");
  assert.equal(metadataCalls, 1); assert.equal(downloads, 0); assert.equal(installed, 0);
  assert.match(service.status().error!, /Automatic update could not start/);
});

test("a manual check never installs; explicit install downloads one verified installer", async t => {
  let installed = 0;
  const { service } = fixture(t, { fetch: async input => String(input).includes("api.github.com") ? Response.json(metadata()) : new Response(bytes),
    install: async path => { assert.deepEqual(readFileSync(path), bytes); installed++; } });
  await Promise.all([service.check(), service.check()]); assert.equal(installed, 0);
  service.install("2.0.0"); assert.throws(() => service.install("2.0.0"));
  await until(() => installed === 1); assert.equal(service.status().progress, 100);
});

test("an unopenable staging file cancels its response and permits a repaired explicit retry", async t => {
  let installed = 0, cancelled = 0, blocked = true;
  let downloadSignal: AbortSignal | undefined;
  const { service, directory } = fixture(t, { fetch: async (input, init) => {
    if (String(input).includes("api.github.com")) return Response.json(metadata());
    downloadSignal = init?.signal || undefined;
    return blocked ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); }, cancel() { cancelled++; },
    })) : new Response(bytes);
  }, install: async path => { assert.deepEqual(readFileSync(path), bytes); installed++; } });
  await service.check();
  const staging = join(directory, "updates/installer-2.0.0.run.part"); mkdirSync(staging, { recursive: true });
  service.install("2.0.0"); await until(() => cancelled === 1);
  assert.equal(service.status().phase, "idle"); assert.ok(service.status().error);
  assert.equal(downloadSignal?.aborted, true); assert.equal(installed, 0);
  rmdirSync(staging); blocked = false;
  await service.check(); service.install("2.0.0"); await until(() => installed === 1);
  await until(() => downloadSignal?.aborted === true);
  assert.equal(service.status().phase, "idle");
});

test("staging directory and status persistence failures return idle without running an installer", async t => {
  let installed = 0, downloads = 0;
  const { service, directory } = fixture(t, { fetch: async input => {
    if (String(input).includes("api.github.com")) return Response.json(metadata());
    downloads++; return new Response(bytes);
  }, install: async () => { installed++; } });
  await service.check();
  const staging = join(directory, "updates"), pendingStatus = join(directory, "update-settings.json.tmp");
  writeFileSync(staging, "Blocks staging directory creation"); mkdirSync(pendingStatus);
  service.install("2.0.0"); await until(() => service.status().phase === "idle");
  assert.ok(service.status().error); assert.equal(installed, 0); assert.equal(downloads, 0);
  unlinkSync(staging); rmdirSync(pendingStatus);
  await service.check(); service.install("2.0.0"); await until(() => installed === 1);
  assert.equal(downloads, 1);
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

test("headless update recovery notices a dead worker without status polling or another release request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let calls = 0;
  const { service, directory, options } = fixture(t, { automatic: true, workerAlive: () => false,
    fetch: async () => { calls++; return Response.json(metadata()); } });
  service.configure(false); await service.close();
  const job = pendingJob(directory, Date.now() - 5000);
  const restored = new UpdateService(options); t.after(() => restored.close());
  assert.equal(existsSync(join(directory, "updates/job.json")), true);
  t.mock.timers.tick(15_000);
  assert.equal(existsSync(join(directory, "updates/job.json")), false, "worker recovery runs independently of clients asking for status");
  const result = JSON.parse(readFileSync(join(directory, "update-result.json"), "utf8"));
  assert.equal(result.id, job.id); assert.equal(result.status, "failed");
  t.mock.timers.tick(24 * 60 * 60_000); assert.equal(calls, 0, "opt-out still prevents release network requests");
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
