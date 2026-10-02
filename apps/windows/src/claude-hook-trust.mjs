import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const run = promisify(execFile);
async function json(path, optional = true) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (optional && error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new Error();
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!object(value)) throw new Error();
  return value;
}
async function argumentsOf(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return [];
  if (process.platform === "linux") return (await readFile(`/proc/${owner.pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  if (process.platform !== "win32") throw new Error();
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid}'; if($null -eq $p){exit 1}; [Console]::Write($p.CommandLine)`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 900, maxBuffer: 64_000 });
  // Settings paths and inline JSON use the ordinary quoted command-line form.
  // Unrecognised quoting fails closed below rather than executing any text.
  return (stdout.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) || []).map(value =>
    value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value);
}
function commands(config, eventName) {
  const groups = config?.hooks?.[eventName];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new Error();
  return groups.flatMap(group => {
    if (!object(group) || !Array.isArray(group.hooks)) throw new Error();
    return group.hooks.map(hook => object(hook) && hook.type === "command" && typeof hook.command === "string" ? hook.command : null);
  });
}

/** Stop is emitted before Claude combines other hooks' decisions. Only our
 * known handlers are trusted; arbitrary handlers may resume the same turn.
 * This inspects known local settings, never executes custom hooks. Dynamic
 * skill/runtime and remote managed policy remain a documented beta limit. */
export async function stopHookTrust({ eventName, cwd, data, runDirectory, owner, configRoot, argv, managedPaths, projectPaths }) {
  if (eventName !== "Stop" && eventName !== "SubagentStop") return { trusted: false, reason: "unverified_sources" };
  try {
    const root = resolve(configRoot || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    const configs = new Map(), allowed = new Set();
    const record = await json(join(data, "claude-monitor-registration.json"));
    if (record) {
      if (record.version !== 1 || !isAbsolute(record.settingsPath || "") || !Array.isArray(record.commands) ||
          record.commands.length > 8 || record.commands.some(value => typeof value !== "string" || value.length > 32_768)) throw new Error();
      const ownedPath = resolve(record.settingsPath);
      configs.set(ownedPath, await json(ownedPath));
      // A command is owned only in its recorded global settings file.
      for (const command of record.commands) allowed.add(ownedPath + "\0" + command);
    }
    const userPath = join(root, "settings.json"); configs.set(userPath, await json(userPath));
    if (runDirectory) {
      const path = join(resolve(runDirectory), "settings.json"), config = await json(path, false);
      const hookArgs = [process.execPath, "--import", new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
        fileURLToPath(new URL("./connectors/claude-hook.ts", import.meta.url)), runDirectory];
      const literal = value => "'" + value.replace(/'/g, "''") + "'";
      const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
      const script = "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::In.ReadToEnd() | & " + hookArgs.map(literal).join(" ");
      const exactCommand = process.platform === "linux" ? hookArgs.map(shellQuote).join(" ")
        : "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + Buffer.from(script, "utf16le").toString("base64");
      for (const command of commands(config, eventName)) {
        if (command !== exactCommand) return { trusted: false, reason: "additional_hooks" };
        allowed.add(path + "\0" + command);
      }
      configs.set(path, config);
    }
    if (projectPaths) for (const path of projectPaths) configs.set(path, await json(path));
    const bases = projectPaths ? [] : [cwd, process.env.CLAUDE_PROJECT_DIR].filter(value => typeof value === "string" && isAbsolute(value));
    for (const base of bases) {
      let path = resolve(base);
      for (let count = 0; count < 32; count++) {
        for (const name of ["settings.json", "settings.local.json"]) {
          const file = join(path, ".claude", name);
          if (!configs.has(file)) configs.set(file, await json(file));
        }
        const parent = dirname(path); if (parent === path) break; path = parent;
        if (count === 31) return { trusted: false, reason: "unverified_sources" };
      }
    }
    const managed = managedPaths || (process.platform === "win32"
      ? [join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json")]
      : ["/etc/claude-code/managed-settings.json"]);
    for (const path of managed) configs.set(path, await json(path));
    const args = argv || await argumentsOf(owner);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--plugin-dir" || arg.startsWith("--plugin-dir=")) return { trusted: false, reason: "unverified_sources" };
      if (arg !== "--settings" && !arg.startsWith("--settings=")) continue;
      const value = arg === "--settings" ? args[++index] : arg.slice(11);
      if (!value) return { trusted: false, reason: "unverified_sources" };
      if (value.startsWith("{")) { const config = JSON.parse(value); if (!object(config)) throw new Error(); configs.set("inline", config); }
      else { const path = resolve(cwd, value); if (!configs.has(path)) configs.set(path, await json(path, false)); }
    }
    for (const [path, config] of configs) {
      if (!config) continue;
      if (config.enabledPlugins && (!object(config.enabledPlugins) || Object.values(config.enabledPlugins).some(Boolean)))
        return { trusted: false, reason: "unverified_sources" };
      if (commands(config, eventName).some(command => command === null || !allowed.has(path + "\0" + command)))
        return { trusted: false, reason: "additional_hooks" };
    }
    return { trusted: true };
  } catch { return { trusted: false, reason: "unreadable_settings" }; }
}
