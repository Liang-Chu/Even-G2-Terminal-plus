import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Tunnel } from "../cockpit-state/types.js";
import { resolvePi, type PiCommand } from "../pi-runtime/resolve-pi.js";

export function resolveAgent(tunnel: Tunnel, override = process.env["EVEN_PILOT_" + tunnel.toUpperCase()]): PiCommand {
  if (tunnel === "pi") return resolvePi(override);
  const value = override || tunnel, explicit = isAbsolute(value) || /[\\/]/.test(value);
  const roots = explicit ? [dirname(resolve(value))] : (process.env.PATH || "").split(delimiter);
  const asCommand = (path: string): PiCommand => {
    const actual = realpathSync(path);
    if (/\.[cm]?js$/i.test(actual)) return { command: process.execPath, args: [actual] };
    if (/\.(cmd|bat|ps1)$/i.test(actual)) throw new Error("Use the native executable or package JS entry, not a shell shim");
    return { command: actual, args: [] };
  };
  for (const root of roots) {
    const candidate = explicit ? resolve(value) : join(root, process.platform === "win32" ? value + ".exe" : value);
    if (existsSync(candidate)) return asCommand(candidate);
    const packageRoot = join(root, "node_modules", tunnel === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code");
    try {
      const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[tunnel];
      if (typeof bin === "string" && existsSync(join(packageRoot, bin))) return asCommand(join(packageRoot, bin));
    } catch { /* Not an installation on this PATH entry. */ }
  }
  throw new Error(tunnel + " was not found. Install its CLI or set EVEN_PILOT_" + tunnel.toUpperCase() + " to its executable.");
}
