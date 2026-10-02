import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { runSettingsCommand, type SettingsContext } from "../apps/linux/src/settings-cli.js";

const sourceId = "12345678-1234-1234-1234-123456789abc", centerId = "abcdef12-1234-1234-1234-123456789abc";
const pairing = "synthetic-center-connection-key-only", relay = "R".repeat(43);
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const service = () => ({ type: "service_account", project_id: "even-glance", client_email: "fixture@even-glance.iam.gserviceaccount.com",
  private_key: privateKey, token_uri: "https://oauth2.googleapis.com/token", universe_domain: "googleapis.com" });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pilot-settings-")), directory = join(root, "data"), keyFile = join(root, "center-key.txt"), credentials = join(root, "service.json");
  await mkdir(directory);
  const config = { controlToken: "fixture-control-token-retained", notificationToken: "fixture-notify-token-retained", custom: { retained: true } };
  await writeFile(join(directory, "bridge-config.json"), JSON.stringify(config));
  await writeFile(keyFile, pairing + "\n"); await writeFile(credentials, JSON.stringify(service()));
  const lines: string[] = [], calls: { path: string; body?: object }[] = [], remoteCalls: { origin: string; path: string; key: string; body: object }[] = [];
  let restarts = 0;
  const context: SettingsContext = { directory, env: {}, write: line => { lines.push(line); }, restart: async () => { restarts++; },
    request: async (path, body) => {
      calls.push({ path, body });
      return Response.json(path === "/api/host" ? { id: sourceId, name: "laptop" }
        : path === "/api/glance/push" ? { configured: true, subscriptions: [{ token: "not-printed" }] }
          : { mode: "direct", target: null, sources: [{ key: relay }], token: pairing });
    }, remoteRequest: async (origin, path, key, body) => {
      remoteCalls.push({ origin, path, key, body }); return Response.json({ id: centerId, name: "nuc", key: relay });
    } };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, config, keyFile, credentials, context, lines, calls, remoteCalls, restarts: () => restarts };
}

test("headless settings status is read-only and prints no credential or raw API record", async t => {
  const f = await fixture(t);
  await runSettingsCommand([], f.context);
  assert.equal(f.restarts(), 0); assert(f.calls.every(call => !call.body));
  assert.deepEqual(f.calls.map(call => call.path).sort(), ["/api/glance/push", "/api/glance/routing"]);
  assert.match(f.lines.join("\n"), /Delivery: direct.*Firebase sender: configured/s);
  for (const key of [pairing, relay, privateKey, "not-printed", f.config.controlToken, f.config.notificationToken]) assert(!f.lines.join("\n").includes(key));
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, "bridge-config.json"), "utf8")), f.config);
});

test("direct delivery never contacts a center or restarts native monitoring", async t => {
  const f = await fixture(t);
  await runSettingsCommand(["push", "direct"], f.context);
  assert.deepEqual(f.calls, [{ path: "/api/glance/routing", body: { mode: "direct" } }]);
  assert.equal(f.remoteCalls.length, 0); assert.equal(f.restarts(), 0);
});

test("forwarding reads a center key from file and stores only the dedicated registered relay credential", async t => {
  const f = await fixture(t);
  await runSettingsCommand(["push", "forward", "--url", "http://100.64.0.2:4317", "--key-file", f.keyFile], f.context);
  assert.deepEqual(f.remoteCalls, [{ origin: "http://100.64.0.2:4317", path: "/api/glance/relay/register", key: pairing,
    body: { sourceId, sourceName: "laptop" } }]);
  assert.deepEqual(f.calls.at(-1), { path: "/api/glance/routing", body: { mode: "relay", target: { id: centerId, name: "nuc", url: "http://100.64.0.2:4317", key: relay } } });
  assert.equal(f.restarts(), 0); assert(!f.lines.join("\n").includes(pairing)); assert(!f.lines.join("\n").includes(relay));
});

test("invalid origins, inline keys and nonregular or oversized key files fail before API changes", async t => {
  const f = await fixture(t);
  for (const origin of ["file:///tmp/key", "http://user:secret@host", "https://host/api", "http://host/?token=secret", "http://host/#secret"])
    await assert.rejects(runSettingsCommand(["push", "forward", "--url", origin, "--key-file", f.keyFile], f.context), error => error instanceof Error && !error.message.includes("secret"));
  for (const args of [["push", "forward", "--url", "http://host", "--key", pairing], ["push", "direct", pairing], ["firebase", "clear", "--credentials", f.credentials]])
    await assert.rejects(runSettingsCommand(args, f.context), error => error instanceof Error && !error.message.includes(pairing));
  const oversized = join(f.root, "oversize.txt"); await writeFile(oversized, "x".repeat(4097));
  for (const path of [f.directory, oversized, join(f.root, "missing-" + pairing), "invalid\0" + pairing])
    await assert.rejects(runSettingsCommand(["push", "forward", "--url", "http://host", "--key-file", path], f.context), error => error instanceof Error && !error.message.includes(pairing));
  await writeFile(f.keyFile, pairing + "\nextra");
  await assert.rejects(runSettingsCommand(["push", "forward", "--url", "http://host", "--key-file", f.keyFile], f.context), /one valid connection key/);
  assert.equal(f.calls.length, 0); assert.equal(f.remoteCalls.length, 0);
});

test("credential setting and clearing preserve pairing keys and the original service-account file", async t => {
  const f = await fixture(t), path = join(f.directory, "bridge-config.json");
  await runSettingsCommand(["firebase", "--credentials", f.credentials], f.context);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...f.config, firebaseProjectId: "even-glance", firebaseCredentialsPath: f.credentials });
  assert.equal(f.restarts(), 1); assert.equal(f.calls.length, 0);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await runSettingsCommand(["firebase", "clear"], f.context);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), f.config);
  assert.equal(f.restarts(), 2); assert.equal((await stat(f.credentials)).isFile(), true);
  for (const key of [privateKey, pairing, f.config.controlToken, f.config.notificationToken]) assert(!f.lines.join("\n").includes(key));
});

test("malformed, wrong-project, hostile-endpoint and oversized credentials never change local config", async t => {
  const f = await fixture(t), path = join(f.directory, "bridge-config.json"), unchanged = await readFile(path, "utf8");
  for (const data of ["{\"private_key\":\"" + pairing, "x".repeat(128001), JSON.stringify({ ...service(), project_id: "different-project" }),
    JSON.stringify({ ...service(), type: "authorized_user" }), JSON.stringify({ ...service(), client_email: "invalid" }),
    JSON.stringify({ ...service(), private_key: pairing }), JSON.stringify({ ...service(), token_uri: "https://host/?key=" + pairing }),
    JSON.stringify({ ...service(), universe_domain: "host" })]) {
    await writeFile(f.credentials, data);
    await assert.rejects(runSettingsCommand(["firebase", "--credentials", f.credentials], f.context), error => error instanceof Error && !error.message.includes(pairing) && !error.message.includes(privateKey));
    assert.equal(await readFile(path, "utf8"), unchanged);
  }
  await assert.rejects(runSettingsCommand(["firebase", "--credentials", f.directory], f.context), /regular readable file/);
  assert.equal(f.restarts(), 0);
});

test("canonical credential paths, environment overrides and restart failures never expose their contents", async t => {
  const f = await fixture(t);
  const link = join(f.root, "service-link.json");
  if (process.platform !== "win32") {
    await symlink(f.credentials, link);
    await runSettingsCommand(["firebase", "--credentials", link], f.context);
    assert.equal(JSON.parse(await readFile(join(f.directory, "bridge-config.json"), "utf8")).firebaseCredentialsPath, f.credentials);
  }
  await assert.rejects(runSettingsCommand(["firebase", "--credentials", f.credentials], { ...f.context,
    env: { GOOGLE_APPLICATION_CREDENTIALS: privateKey, EVEN_PILOT_FCM_PROJECT_ID: pairing }, restart: async () => { throw new Error(privateKey); },
  }), error => error instanceof Error && !error.message.includes(privateKey) && /Settings were saved/.test(error.message));
  assert(f.lines.some(line => line.includes("Environment overrides")));
  assert(!f.lines.join("\n").includes(privateKey)); assert(!f.lines.join("\n").includes(pairing));
});

test("malformed config, unconfirmed routes and hostile API errors are sanitized with no retry", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "bridge-config.json"), "{\"controlToken\":\"" + pairing);
  await assert.rejects(runSettingsCommand(["firebase", "--credentials", f.credentials], f.context), error => error instanceof Error && !error.message.includes(pairing));
  assert.equal(f.restarts(), 0);
  let changes = 0;
  await assert.rejects(runSettingsCommand(["push", "direct"], { ...f.context, request: async () => { changes++; throw new Error(pairing); } }), /nothing was resent/);
  assert.equal(changes, 1);
  await assert.rejects(runSettingsCommand(["push", "direct"], { ...f.context, request: async () => Response.json({ error: pairing }, { status: 403 }) }), error => error instanceof Error && !error.message.includes(pairing));
  await assert.rejects(runSettingsCommand(["push", "forward", "--url", "http://host", "--key-file", f.keyFile], { ...f.context,
    remoteRequest: async () => Response.json({ id: sourceId, name: "self", key: relay }),
  }), /Invalid center registration/);
  assert(f.calls.every(call => !call.body));
  await runSettingsCommand(["--help"], f.context); assert(f.lines.at(-1)?.includes("--key-file"));
});
