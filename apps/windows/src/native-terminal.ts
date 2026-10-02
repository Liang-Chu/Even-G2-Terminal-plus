import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePi } from "../../../packages/pi-runtime/resolve-pi.js";
import type { Tunnel } from "../../../packages/cockpit-state/types.js";
import { resolveAgent } from "../../../packages/connectors/command.js";
import { openLinuxTerminal, linuxUnregistered } from "../../linux/src/platform.js";

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const encode = (value: string) => Buffer.from(value, "utf16le").toString("base64");
const powershell = () => resolve(process.env.WINDIR || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");

export async function openNativeTerminal(path: string, cwd: string, tunnel: Tunnel = "pi", fresh = false, name?: string) {
  if (!["win32", "linux"].includes(process.platform)) throw new Error("Desktop terminals require Windows or Linux");
  resolveAgent(tunnel);
  const pi = tunnel === "pi" ? resolvePi() : { command: process.execPath, args: [
    "--import", new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("./connectors/terminal.ts", import.meta.url)), "--tunnel", tunnel, "--cwd", cwd,
  ] };
  const sessionArgs = tunnel === "pi" ? ["--session", path] : ["--resume", path, ...(fresh ? ["--fresh"] : []), ...(name ? ["--name", name] : [])];
  if (process.platform === "linux") return openLinuxTerminal([pi.command, ...pi.args, ...sessionArgs], cwd, tunnel, path);
  const terminal = resolve(process.env.LOCALAPPDATA || "", "Microsoft/WindowsApps/wt.exe");
  if (existsSync(terminal)) {
    const child = spawn(terminal, ["-w", "new", "new-tab", "--title", tunnel === "pi" ? "Pi" : tunnel === "codex" ? "Codex" : "Claude Code", "-d", cwd, pi.command, ...pi.args, ...sessionArgs],
      { cwd, detached: true, windowsHide: false, stdio: "ignore", shell: false });
    await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); }); child.unref(); return;
  }
  const run = encode(`Set-Location -LiteralPath ${literal(cwd)}; & ${[pi.command, ...pi.args, ...sessionArgs].map(literal).join(" ")}; exit $LASTEXITCODE`);
  const launch = encode(`Start-Process -FilePath ${literal(powershell())} -ArgumentList ${literal(`-NoLogo -NoProfile -EncodedCommand ${run}`)} -WorkingDirectory ${literal(cwd)}`);
  const child = spawn(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", launch], { windowsHide: true, shell: false, stdio: "ignore" });
  await new Promise<void>((done, fail) => { child.once("error", fail); child.once("exit", code => code === 0 ? done() : fail(new Error("Could not open Pi terminal"))); });
}

/** Do not open a second writer while an existing, not-yet-connected Pi may own the file. */
export async function hasUnregisteredPi(knownPids: number[]) {
  if (process.platform === "linux") return linuxUnregistered(knownPids, "pi");
  if (process.platform !== "win32") return false;
  const known = knownPids.filter(Number.isSafeInteger);
  const script = String.raw`$known = @(${known.join(",")}); $unregistered = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '[\\/]pi-coding-agent[\\/]' -and $_.CommandLine -notmatch '--mode[ =]+rpc' -and $_.Name -notmatch 'powershell|pwsh' -and $known -notcontains $_.ProcessId }); [Console]::Write($unregistered.Count -gt 0)`;
  const child = spawn(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  await new Promise<void>((done, fail) => { child.once("error", fail); child.once("exit", code => code === 0 ? done() : fail(new Error("Could not check existing Pi terminals"))); });
  return output.trim() === "True";
}

export async function hasUnregisteredTerminal(knownPids: number[], tunnel: Tunnel = "pi") {
  if (tunnel === "pi") return hasUnregisteredPi(knownPids);
  if (process.platform === "linux") return linuxUnregistered(knownPids, tunnel);
  if (process.platform !== "win32") return false;
  const known = knownPids.filter(Number.isSafeInteger);
  const name = tunnel === "codex" ? "codex.exe" : "claude.exe";
  const script = `$known = @(${known.join(",")}); $unregistered = @(Get-CimInstance Win32_Process -Filter "Name = '${name}'" | Where-Object { $_.CommandLine -notmatch 'app-server|--version|--help| agents | doctor ' -and $known -notcontains $_.ProcessId -and $known -notcontains $_.ParentProcessId }); [Console]::Write($unregistered.Count -gt 0)`;
  const child = spawn(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  await new Promise<void>((done, fail) => { child.once("error", fail); child.once("exit", code => code === 0 ? done() : fail(new Error("Could not check existing terminals"))); });
  return output.trim() === "True";
}
