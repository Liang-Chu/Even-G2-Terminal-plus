import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { installClaudeMonitor, removeClaudeMonitor, claudeMonitorEvents } from "../apps/windows/src/install-claude-monitor.js";
import { claudeProcessIdentity } from "../apps/windows/src/connectors/claude-interrupt.js";
import { installationRoot } from "../apps/windows/src/config.js";

const run = promisify(execFile);
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pilot-claude-hooks-")), data = join(root, "data"), configDirectory = join(root, "profile");
  await mkdir(configDirectory); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data, configDirectory, installationRoot: join(root, "install"),
    path: join(configDirectory, "settings.json"), registration: join(data, "claude-monitor-registration.json") };
}
const parse = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("owned Claude hooks preserve settings and unrelated handlers through install/update/removal", async t => {
  const f = await fixture(t), original = { permissions: { allow: ["Read"] }, env: { USER_SETTING: "value" },
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "existing-hook", timeout: 17 }] },
      { matcher: "", hooks: [] }], UnrelatedEvent: [{ hooks: [{ type: "command", command: "keep" }] }] } };
  await writeFile(f.path, JSON.stringify(original));
  const first = installClaudeMonitor({ ...f, platform: "linux", node: join(f.root, "node one") });
  const firstConfig = await parse(f.path), firstRegistration = await parse(f.registration);
  assert.deepEqual(firstConfig.permissions, original.permissions); assert.deepEqual(firstConfig.env, original.env);
  assert.deepEqual(firstConfig.hooks.Stop.slice(0, 2), original.hooks.Stop);
  for (const name of claudeMonitorEvents) {
    const handler = firstConfig.hooks[name].at(-1).hooks[0];
    assert.deepEqual(Object.keys(handler).sort(), ["command", "timeout", "type"]);
    assert.equal(handler.type, "command"); assert.equal(handler.timeout, 3);
  }
  installClaudeMonitor({ ...f, platform: "linux", node: join(f.root, "node one") });
  assert.deepEqual(await parse(f.path), firstConfig, "Repeated prepare does not duplicate handlers");
  const second = installClaudeMonitor({ ...f, platform: "linux", node: join(f.root, "node two") });
  const secondRegistration = await parse(f.registration);
  assert.notEqual(secondRegistration.commands[0], firstRegistration.commands[0]);
  assert.equal(second.hookPath, first.hookPath, "Hook file remains outside version payloads");
  assert.equal(JSON.stringify(await parse(f.path)).includes(firstRegistration.commands[0]), false);
  assert.equal(removeClaudeMonitor({ data: f.data, installationRoot: f.installationRoot }), true);
  assert.deepEqual(await parse(f.path), original);
  await assert.rejects(readFile(first.hookPath), /ENOENT/); await assert.rejects(readFile(f.registration), /ENOENT/);
  assert.equal(removeClaudeMonitor({ data: f.data, installationRoot: f.installationRoot }), false);
});

test("removal matches exact owned command and keeps a user command with appended arguments", async t => {
  const f = await fixture(t); installClaudeMonitor({ ...f, platform: "linux" });
  const config = await parse(f.path), owned = (await parse(f.registration)).commands[0];
  const extra = { hooks: [{ type: "command", command: owned + " --user-script", timeout: 99 }] };
  config.hooks.Stop.push(extra); await writeFile(f.path, JSON.stringify(config));
  removeClaudeMonitor({ data: f.data, installationRoot: f.installationRoot }); assert.deepEqual(await parse(f.path), { hooks: { Stop: [extra] } });
});

test("invalid or unsupported Claude settings fail visibly without overwriting", async t => {
  const f = await fixture(t);
  for (const body of ["{invalid", "[]", '{"hooks":[]}', '{"hooks":{"Stop":[{"hooks":"wrong"}]}}']) {
    await writeFile(f.path, body);
    assert.throws(() => installClaudeMonitor({ ...f }), /Claude settings/);
    assert.equal(await readFile(f.path, "utf8"), body); await assert.rejects(readFile(f.registration), /ENOENT/);
  }
});

test("unrelated or edited hook files are preserved and block unsafe removal", async t => {
  const f = await fixture(t); await mkdir(f.data);
  const hook = join(f.data, "claude-monitor-hook.mjs"); await writeFile(hook, "user-owned file");
  assert.throws(() => installClaudeMonitor({ ...f }), /unrelated/);
  assert.equal(await readFile(hook, "utf8"), "user-owned file");
  await rm(hook); installClaudeMonitor({ ...f }); await writeFile(hook, "user edit");
  const before = await readFile(f.path, "utf8");
  assert.throws(() => removeClaudeMonitor({ data: f.data, installationRoot: f.installationRoot }), /modified/);
  assert.equal(await readFile(f.path, "utf8"), before); assert.equal(await readFile(hook, "utf8"), "user edit");
});

test("recorded profile location remains removable after environment changes; another root cannot remove it", async t => {
  const f = await fixture(t); installClaudeMonitor({ ...f }); const before = await readFile(f.path, "utf8");
  assert.throws(() => installClaudeMonitor({ ...f, configDirectory: join(f.root, "other") }), /location changed/);
  assert.throws(() => installClaudeMonitor({ ...f, installationRoot: join(f.root, "other-install") }), /another installation/);
  assert.throws(() => removeClaudeMonitor({ data: f.data, installationRoot: join(f.root, "other-install") }), /another installation/);
  assert.equal(await readFile(f.path, "utf8"), before);
  removeClaudeMonitor({ data: f.data, installationRoot: f.installationRoot }); assert.deepEqual(await parse(f.path), {});
});

test("Windows command encoding protects literal Unicode and shell metacharacters", async t => {
  const f = await fixture(t), node = join(f.root, "node ' $() ` 中文.exe");
  installClaudeMonitor({ ...f, platform: "win32", node });
  const command = (await parse(f.registration)).commands[0];
  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = Buffer.from(command.split(" ").at(-1), "base64").toString("utf16le");
  assert.ok(script.includes("'" + node.replace(/'/g, "''") + "'"));
  assert.ok(script.includes("[Console]::In.Read($buffer,0,$buffer.Length)"));
  assert.ok(script.includes("256000"));
  assert.equal(script.includes("--import"), false, "Standalone hook requires no tsx at runtime");
});

test("installed removal entrypoint reports malformed ownership instead of hiding failure", async t => {
  const f = await fixture(t); installClaudeMonitor({ ...f, installationRoot: installationRoot() });
  const args = ["--import", "tsx", resolve("apps/windows/src/install-claude-monitor.ts"), "--remove", "--data", f.data];
  const result = await run(process.execPath, args, { windowsHide: true }); assert.equal(result.stderr, "");
  assert.deepEqual(await parse(f.path), {});
  await writeFile(f.registration, "bad");
  await assert.rejects(run(process.execPath, args, { windowsHide: true }), (error: any) => {
    assert.equal(error.code, 1); assert.match(error.stderr, /registration is unreadable/); return true;
  });
});

test("removal entrypoint rejects hooks owned by a different installation root", async t => {
  const f = await fixture(t); installClaudeMonitor({ ...f }); const before = await readFile(f.path, "utf8");
  await assert.rejects(run(process.execPath, ["--import", "tsx", resolve("apps/windows/src/install-claude-monitor.ts"), "--remove", "--data", f.data],
    { windowsHide: true }), (error: any) => { assert.equal(error.code, 1); assert.match(error.stderr, /another installation/); return true; });
  assert.equal(await readFile(f.path, "utf8"), before); assert.equal((await parse(f.registration)).installationRoot, f.installationRoot);
});

test("the installed Windows hook command forwards actual stdin without a console or CLI control", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t); installClaudeMonitor({ ...f });
  const command = (await parse(f.registration)).commands[0];
  const encoded = command.split(" ").at(-1);
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
  child.stdin.end(JSON.stringify({ session_id: "12345678-abcd-abcd-abcd-123456789012", hook_event_name: "UserPromptSubmit",
    cwd: f.root, transcript_path: join(f.root, "session.jsonl"), prompt: "Unicode 中文 fixture" }));
  const [code] = await once(child, "exit"); assert.equal(code, 0); assert.equal(stderr, ""); assert.equal(stdout.trim(), "{}");
  const files = await import("node:fs/promises").then(fs => fs.readdir(join(f.data, "claude-events")));
  assert.equal(files.length, 1);
  const event = await parse(join(f.data, "claude-events", files[0])); assert.equal(event.prompt, "Unicode 中文 fixture");
  assert.equal(event.owner, undefined, "A fixture PowerShell/Node tree is not a Claude process");
});

test("Windows hook identifies a hidden synthetic npm-Claude ancestor with the exact native start identity", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), runtime = join(f.installationRoot, "runtime"), helper = join(f.installationRoot, "apps", "windows", "desktop");
  await mkdir(runtime, { recursive: true }); await mkdir(helper, { recursive: true });
  await copyFile(process.execPath, join(runtime, "node.exe"));
  const compiler = join(process.env.WINDIR!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  await run(compiler, ["/nologo", "/target:exe", "/optimize+", "/out:" + join(helper, "Even-Pilot.TerminalInterrupt.exe"),
    "/reference:System.Web.Extensions.dll", resolve("apps/windows/desktop/TerminalInterrupt.cs")], { windowsHide: true });
  // The desktop bridge has already started this bundled runtime before hooks are installed.
  await run(join(runtime, "node.exe"), ["--version"], { windowsHide: true });
  installClaudeMonitor({ ...f, node: join(runtime, "node.exe") });
  const command = (await parse(f.registration)).commands[0], encoded = command.split(" ").at(-1);
  const folder = join(f.root, "node_modules", "@anthropic-ai", "claude-code"); await mkdir(folder, { recursive: true });
  const cli = join(folder, "cli.js"), request = join(f.root, "request.json");
  await writeFile(request, JSON.stringify({ encoded, input: { session_id: "12345678-abcd-abcd-abcd-123456789012", hook_event_name: "UserPromptSubmit",
    cwd: f.root, transcript_path: join(f.root, "session.jsonl"), prompt: "Synthetic fixture only" } }));
  await writeFile(cli, "const fs=require('node:fs'),{spawn}=require('node:child_process'); const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); const at=Date.now(); const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',request.encoded],{windowsHide:true,stdio:['pipe','pipe','pipe']}); let stdout='',stderr=''; child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c); child.stdin.end(JSON.stringify(request.input)); child.on('exit',code=>process.stdout.write(JSON.stringify({code,stdout,stderr,elapsed:Date.now()-at})+'\\n')); process.stdin.resume(); process.stdin.on('data',()=>process.exit(0));");
  const parent = spawn(process.execPath, [cli, request, "Unicode 中文 fixture"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { if (parent.exitCode === null) { parent.stdin.write("close"); await once(parent, "exit"); } });
  const result: any = await new Promise((done, fail) => {
    let body = ""; const timeout = setTimeout(() => fail(new Error("Fixture hook timeout")), 7000);
    parent.once("error", fail); parent.stdout.on("data", chunk => { body += chunk; if (body.includes("\n")) { clearTimeout(timeout); try { done(JSON.parse(body)); } catch (error) { fail(error); } } });
  });
  assert.equal(result.code, 0); assert.equal(result.stderr, ""); assert.equal(result.stdout.trim(), "{}");
  const files = await import("node:fs/promises").then(fs => fs.readdir(join(f.data, "claude-events")));
  const event = await parse(join(f.data, "claude-events", files[0])); assert.equal(event.owner.pid, parent.pid);
  const directAt = Date.now(), direct = await run(join(helper, "Even-Pilot.TerminalInterrupt.exe"), ["claude-owner", String(parent.pid)], { windowsHide: true });
  assert.equal(JSON.parse(direct.stdout).pid, parent.pid, "Native ancestry helper must recognize npm Claude without PowerShell fallback");
  assert.equal(JSON.parse(direct.stdout).argv.at(-1), "Unicode 中文 fixture");
  t.diagnostic(`Native owner lookup completed in ${Date.now() - directAt} ms`);
  assert.deepEqual(Object.keys(event.owner).sort(), ["pid", "started"], "Private helper argv is never persisted");
  if (existsSync(resolve("apps/windows/desktop/Even-Pilot.TerminalInterrupt.exe")))
    assert.equal(event.owner.started, await claudeProcessIdentity(parent.pid!));
  t.diagnostic(`Synthetic Windows ordinary hook completed in ${result.elapsed} ms`);
});
