import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory, installationRoot as currentInstallationRoot } from "./config.js";

export const claudeMonitorEvents = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SubagentStart",
  "SubagentStop", "SessionEnd", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];
export interface ClaudeMonitorOptions {
  data?: string;
  configDirectory?: string;
  installationRoot?: string;
  node?: string;
  platform?: "win32" | "linux";
}
interface Registration {
  version: 1; settingsPath: string; hookPath: string; installationRoot: string;
  commands: string[]; hashes: string[]; trustPath: string; trustHashes: string[];
}
const filename = "claude-monitor-registration.json";
const hookSource = fileURLToPath(new URL("./claude-monitor-hook.mjs", import.meta.url));
const trustSource = fileURLToPath(new URL("./claude-hook-trust.mjs", import.meta.url));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const literal = (value: string) => "'" + value.replace(/'/g, "''") + "'";
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const object = (value: any): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

function regular(path: string, limit: number) {
  let stat;
  try { stat = lstatSync(path); } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error("Claude monitor settings or registration is not a bounded regular file; no settings changed.");
  return true;
}
function settings(path: string) {
  if (!regular(path, 1_048_576)) return { value: {} as Record<string, any>, source: undefined };
  const source = readFileSync(path, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new Error("Claude settings cannot be parsed; repair settings.json before preparing or removing Terminal+."); }
  if (!object(parsed) || (parsed.hooks !== undefined && !object(parsed.hooks)))
    throw new Error("Claude settings have an unsupported hooks structure; no settings changed.");
  for (const event of claudeMonitorEvents) {
    const groups = parsed.hooks?.[event];
    if (groups !== undefined && (!Array.isArray(groups) || groups.some((group: any) => !object(group) || !Array.isArray(group.hooks))))
      throw new Error("Claude settings contain an unsupported hook group; no settings changed.");
  }
  return { value: parsed, source };
}
function unchanged(path: string, expected: string | undefined) {
  const current = regular(path, 1_048_576) ? readFileSync(path, "utf8") : undefined;
  if (current !== expected) throw new Error("Claude settings changed during preparation or removal; retry without changing the profile at the same time.");
}
function registration(path: string, data: string): Registration | undefined {
  if (!regular(path, 32_768)) return;
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Claude monitor ownership registration is unreadable; no settings changed."); }
  if (!object(parsed) || parsed.version !== 1 || !isAbsolute(parsed.settingsPath || "")
    || parsed.hookPath !== join(data, "claude-monitor-hook.mjs") || !isAbsolute(parsed.installationRoot || "")
    || parsed.trustPath !== join(data, "claude-hook-trust.mjs")
    || !Array.isArray(parsed.commands) || parsed.commands.length < 1 || parsed.commands.length > 8
    || parsed.commands.some((command: any) => typeof command !== "string" || command.length > 32_768 || !command.trim())
    || !Array.isArray(parsed.hashes) || !parsed.hashes.length || parsed.hashes.length > 8
    || parsed.hashes.some((hash: any) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
    || !Array.isArray(parsed.trustHashes) || !parsed.trustHashes.length || parsed.trustHashes.length > 8
    || parsed.trustHashes.some((hash: any) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))
    throw new Error("Claude monitor ownership registration is invalid; no settings changed.");
  return parsed as unknown as Registration;
}
function atomic(path: string, body: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  try { writeFileSync(temporary, body, { flag: "wx", mode }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch {} }
}
function withoutOwned(config: Record<string, any>, commands: string[]) {
  if (!config.hooks) return config;
  for (const event of claudeMonitorEvents) {
    if (!config.hooks[event]) continue;
    config.hooks[event] = config.hooks[event].flatMap((group: any) => {
      const hooks = group.hooks.filter((hook: any) => !(object(hook) && hook.type === "command" && commands.includes(hook.command)));
      if (hooks.length === group.hooks.length) return [group];
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  if (!Object.keys(config.hooks).length) delete config.hooks;
  return config;
}
function ownedHookIntact(path: string, hashes: string[]) {
  if (regular(path, 128_000) && !hashes.includes(digest(readFileSync(path, "utf8"))))
    throw new Error("Terminal+'s Claude monitor hook was modified; preserve or restore it before updating or uninstalling.");
}

/** The stable data copy survives an installer payload switch or rollback. */
export function installClaudeMonitor(options: ClaudeMonitorOptions = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32" && platform !== "linux") throw new Error("Claude monitoring requires Windows or Linux.");
  const data = resolve(options.data || dataDirectory()), recordPath = join(data, filename);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  if (!lstatSync(data).isDirectory() || lstatSync(data).isSymbolicLink()) throw new Error("Claude monitor data directory must be a real directory.");
  const previous = registration(recordPath, data), hookPath = join(data, "claude-monitor-hook.mjs");
  const trustPath = join(data, "claude-hook-trust.mjs");
  const configDirectory = resolve(options.configDirectory || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  const path = join(configDirectory, "settings.json"), root = resolve(options.installationRoot || currentInstallationRoot());
  if (previous && previous.installationRoot !== root)
    throw new Error("Claude monitor belongs to another installation; no settings changed.");
  if (previous && previous.settingsPath !== path)
    throw new Error("Claude configuration location changed; remove the existing Terminal+ registration before preparing another profile.");
  const saved = settings(path), config = withoutOwned(saved.value, previous?.commands || []);
  if (regular(hookPath, 128_000)) {
    if (!previous) throw new Error("An unrelated Claude monitor hook file already exists; no settings changed.");
    ownedHookIntact(hookPath, previous.hashes);
  }
  if (regular(trustPath, 128_000)) {
    if (!previous) throw new Error("An unrelated Claude monitor trust file already exists; no settings changed.");
    ownedHookIntact(trustPath, previous.trustHashes);
  }
  const source = readFileSync(hookSource, "utf8"), hash = digest(source), node = resolve(options.node || process.execPath);
  const trust = readFileSync(trustSource, "utf8"), trustHash = digest(trust);
  const args = [node, hookPath, data];
  const script = "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; try { $OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $hookInput=[Text.StringBuilder]::new(); $buffer=[char[]]::new(4096); while(($count=[Console]::In.Read($buffer,0,$buffer.Length)) -gt 0){ if($hookInput.Length+$count -gt 256000){ [Console]::Write('{}'); exit 0 }; [void]$hookInput.Append($buffer,0,$count) }; $hookInput.ToString() | & " + args.map(literal).join(" ") + " 2>$null; if($LASTEXITCODE -ne 0){ [Console]::Write('{}') } } catch { [Console]::Write('{}') }; exit 0";
  const command = platform === "linux" ? args.map(shellQuote).join(" ")
    : "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + Buffer.from(script, "utf16le").toString("base64");
  config.hooks ||= {};
  for (const event of claudeMonitorEvents) {
    config.hooks[event] ||= [];
    config.hooks[event].push({ hooks: [{ type: "command", command, timeout: 3 }] });
  }
  // Retain both commands/hashes until settings commit, so an interrupted update is removable.
  const pending: Registration = { version: 1, settingsPath: path, hookPath, installationRoot: root, trustPath,
    commands: [...new Set([...(previous?.commands || []), command])], hashes: [...new Set([...(previous?.hashes || []), hash])],
    trustHashes: [...new Set([...(previous?.trustHashes || []), trustHash])] };
  if (pending.commands.length > 8 || pending.hashes.length > 8 || pending.trustHashes.length > 8)
    throw new Error("Claude monitor registration needs repair after repeated interrupted updates.");
  atomic(recordPath, JSON.stringify(pending, null, 2) + "\n");
  atomic(trustPath, trust);
  atomic(hookPath, source);
  const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
  unchanged(path, saved.source);
  atomic(path, JSON.stringify(config, null, 2) + "\n", mode);
  if (platform === "linux") { chmodSync(hookPath, 0o600); chmodSync(trustPath, 0o600); }
  atomic(recordPath, JSON.stringify({ ...pending, commands: [command], hashes: [hash], trustHashes: [trustHash] }, null, 2) + "\n");
  return { settingsPath: path, hookPath, registrationPath: recordPath };
}

/** Remove exactly recorded command handlers; unrelated hooks and all settings survive. */
export function removeClaudeMonitor(options: Pick<ClaudeMonitorOptions, "data" | "installationRoot"> = {}) {
  const data = resolve(options.data || dataDirectory()), recordPath = join(data, filename), owned = registration(recordPath, data);
  if (!owned) return false;
  if (owned.installationRoot !== resolve(options.installationRoot || currentInstallationRoot()))
    throw new Error("Claude monitor belongs to another installation; no settings changed.");
  const saved = settings(owned.settingsPath), config = withoutOwned(saved.value, owned.commands);
  ownedHookIntact(owned.hookPath, owned.hashes);
  ownedHookIntact(owned.trustPath, owned.trustHashes);
  if (existsSync(owned.settingsPath)) {
    const mode = lstatSync(owned.settingsPath).mode & 0o777;
    unchanged(owned.settingsPath, saved.source);
    atomic(owned.settingsPath, JSON.stringify(config, null, 2) + "\n", mode);
  }
  if (existsSync(owned.hookPath)) unlinkSync(owned.hookPath);
  if (existsSync(owned.trustPath)) unlinkSync(owned.trustPath);
  unlinkSync(recordPath);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== "--remove" || args[1] !== "--data" || !isAbsolute(args[2]))
      throw new Error("Usage: install-claude-monitor.ts --remove --data ABSOLUTE_DIRECTORY");
    removeClaudeMonitor({ data: args[2], installationRoot: currentInstallationRoot() });
  } catch (error) { console.error(error instanceof Error ? error.message : "Claude monitor removal failed."); process.exitCode = 1; }
}
