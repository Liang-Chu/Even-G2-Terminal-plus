import { spawn, execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Tunnel } from "../../../packages/cockpit-state/types.js";

const run = promisify(execFile);
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function executable(name: string, path = process.env.PATH || "") {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
}
export function terminalArguments(terminal: string, command: string[], cwd: string, title: string) {
  switch (basename(terminal)) {
    case "gnome-terminal": return ["--working-directory=" + cwd, "--title=" + title, "--", ...command];
    case "konsole": return ["--separate", "--workdir", cwd, "-p", "tabtitle=" + title, "-e", ...command];
    case "kitty": return ["--directory", cwd, "--title", title, ...command];
    case "xfce4-terminal": return ["--disable-server", "--working-directory=" + cwd, "--title=" + title, "--execute", ...command];
    case "xterm": return ["-T", title, "-e", ...command];
    default: return ["-e", ...command];
  }
}
export async function openLinuxTerminal(command: string[], cwd: string, tunnel: Tunnel, session: string) {
  const title = "Even-Pilot · " + tunnel;
  const graphical = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (graphical) {
    const preferred = process.env.EVEN_PILOT_TERMINAL;
    const names = preferred ? [preferred] : ["gnome-terminal", "konsole", "xfce4-terminal", "kitty", "x-terminal-emulator", "xterm"];
    for (const name of names) {
      const terminal = name.startsWith("/") ? name : await executable(name);
      if (!terminal) continue;
      const child = spawn(terminal, terminalArguments(terminal, command, cwd, title), { cwd, detached: true, stdio: "ignore", shell: false });
      await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
      child.unref(); return;
    }
    throw new Error("No supported terminal emulator found. Set EVEN_PILOT_TERMINAL to its executable, then restart Even-Pilot.");
  }
  const tmux = await executable("tmux");
  if (!tmux) throw new Error("Headless Linux needs tmux to open a terminal. Install tmux, or run the CLI in your SSH terminal.");
  const name = "pilot-" + tunnel + "-" + createHash("sha256").update(session).digest("hex").slice(0, 12);
  // Use the user's ordinary tmux server: sessions are visible in `tmux ls` and
  // remain independently attachable after the monitoring service stops.
  try { await run(tmux, ["has-session", "-t", "=" + name]); return; } catch {}
  // An existing tmux server keeps its old environment. Pass only connector
  // locations/PATH per session; never expose model credentials in argv.
  const names = ["PATH", "EVEN_PILOT_DATA_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "EVEN_PILOT_PI", "EVEN_PILOT_CODEX", "EVEN_PILOT_CLAUDE"];
  const environment = names.filter(key => process.env[key] !== undefined).flatMap(key => ["-e", key + "=" + process.env[key]]);
  await run(tmux, ["new-session", "-d", "-s", name, "-c", cwd, ...environment, command.map(shellQuote).join(" ")], { cwd, timeout: 10000 });
}
export async function linuxUnregistered(knownPids: number[], tunnel: Tunnel, proc = "/proc") {
  const known = new Set(knownPids), uid = process.getuid?.();
  for (const name of await readdir(proc)) {
    if (!/^\d+$/.test(name) || known.has(Number(name)) || Number(name) === process.pid) continue;
    try {
      const directory = join(proc, name);
      if ((await stat(directory)).uid !== uid) continue;
      const args = (await readFile(join(directory, "cmdline"), "utf8")).split("\0").filter(Boolean);
      if (!args.length || args.some(arg => ["app-server", "--version", "--help", "doctor"].includes(arg))) continue;
      const entry = basename(args[0]), script = args[1] || "";
      const matches = tunnel === "pi" ? (entry === "pi" || /\/pi-coding-agent\/.*\.[cm]?js$/.test(script)) && !args.includes("rpc")
        : entry === tunnel || (entry === "node" && new RegExp("/(?:@openai/codex|@anthropic-ai/claude-code)/").test(script) && script.includes(tunnel === "codex" ? "codex" : "claude"));
      if (!matches) continue;
      const status = await readFile(join(directory, "status"), "utf8");
      if (known.has(Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]))) continue;
      return true;
    } catch (error: any) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error; }
  }
  return false;
}
