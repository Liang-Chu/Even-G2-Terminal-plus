import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stopHookTrust, type StopHookTrustOptions } from "../apps/windows/src/claude-hook-trust.mjs";

const group = (command: string) => [{ hooks: [{ type: "command", command }] }];
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pilot-claude-trust-"));
  const data = join(root, "data"), profile = join(root, "profile"), cwd = join(root, "project");
  await Promise.all([data, profile, cwd].map(path => mkdir(path)));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const options: StopHookTrustOptions = { eventName: "Stop", cwd, data, configRoot: profile, argv: [], managedPaths: [], projectPaths: [] };
  const json = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  return { root, data, profile, cwd, options, json };
}

test("Claude trusts only the registered managed command in its owned settings file", async t => {
  const f = await fixture(t), path = join(f.profile, "settings.json"), owned = "node managed-observer.mjs";
  await f.json(path, { hooks: { Stop: group(owned) } });
  await f.json(join(f.data, "claude-monitor-registration.json"), { version: 1, settingsPath: path, commands: [owned] });
  assert.equal((await stopHookTrust(f.options)).trusted, true);
  await f.json(path, { hooks: { Stop: [...group(owned), ...group("node custom-quality-gate.mjs")] } });
  assert.deepEqual(await stopHookTrust(f.options), { trusted: false, reason: "additional_hooks" });
});

test("Claude custom project Stop and SubagentStop hooks keep completion uncertain", async t => {
  const f = await fixture(t), directory = join(f.cwd, ".claude");
  await mkdir(directory);
  const path = join(directory, "settings.local.json");
  await f.json(path, { hooks: { Stop: group("quality-gate"), SubagentStop: group("child-gate") } });
  for (const eventName of ["Stop", "SubagentStop"])
    assert.deepEqual(await stopHookTrust({ ...f.options, eventName, projectPaths: [path] }), { trusted: false, reason: "additional_hooks" });
});

test("Claude rejects inline custom settings, plugin sources, and unreadable settings", async t => {
  const f = await fixture(t);
  assert.equal((await stopHookTrust({ ...f.options, argv: ["--settings", JSON.stringify({ hooks: { Stop: group("inline-gate") } })] })).trusted, false);
  assert.equal((await stopHookTrust({ ...f.options, argv: ["--plugin-dir", join(f.root, "plugin")] })).trusted, false);
  await f.json(join(f.profile, "settings.json"), { enabledPlugins: { "custom@marketplace": true } });
  assert.deepEqual(await stopHookTrust(f.options), { trusted: false, reason: "unverified_sources" });
  await writeFile(join(f.profile, "settings.json"), "broken json");
  assert.deepEqual(await stopHookTrust(f.options), { trusted: false, reason: "unreadable_settings" });
});

test("Claude does not trust a copied managed marker in another settings file", async t => {
  const f = await fixture(t), owned = "node managed-observer.mjs", path = join(f.profile, "settings.json");
  await f.json(path, { hooks: { Stop: group(owned) } });
  await f.json(join(f.data, "claude-monitor-registration.json"), { version: 1, settingsPath: path, commands: [owned] });
  const directory = join(f.cwd, ".claude"); await mkdir(directory);
  const projectPath = join(directory, "settings.json");
  await f.json(projectPath, { hooks: { Stop: group(owned) } });
  assert.deepEqual(await stopHookTrust({ ...f.options, projectPaths: [projectPath] }), { trusted: false, reason: "additional_hooks" });
});

test("Claude trusts its generated native hook but rejects wrapped commands in native settings", async t => {
  const f = await fixture(t), runDirectory = join(f.data, "connector-runtime", "run");
  await mkdir(runDirectory, { recursive: true });
  const args = [process.execPath, "--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../apps/windows/src/connectors/claude-hook.ts", import.meta.url)), runDirectory];
  const quote = (value: string) => "'" + value.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
  const script = "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::In.ReadToEnd() | & " + args.map(quote).join(" ");
  const command = process.platform === "win32"
    ? "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + Buffer.from(script, "utf16le").toString("base64")
    : args.map(quote).join(" ");
  const path = join(runDirectory, "settings.json");
  await f.json(path, { hooks: { Stop: group(command) } });
  assert.equal((await stopHookTrust({ ...f.options, runDirectory })).trusted, true);
  await f.json(path, { hooks: { Stop: group(command + " && custom-quality-gate") } });
  assert.equal((await stopHookTrust({ ...f.options, runDirectory })).trusted, false);
});
