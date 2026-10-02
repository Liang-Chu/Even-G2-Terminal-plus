import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HostSource } from "../../../packages/cockpit-state/types.js";

const run = promisify(execFile);
export function tailscaleName(status: unknown): string | undefined {
  const self = (status as any)?.Self;
  const dns = typeof self?.DNSName === "string" ? self.DNSName.split(".")[0] : "";
  const name = dns || (typeof self?.HostName === "string" ? self.HostName : "");
  return name && /^[\p{L}\p{N}_. -]{1,128}$/u.test(name) ? name : undefined;
}
async function readTailscale() {
  const commands = process.platform === "win32" ? ["tailscale.exe", join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale/tailscale.exe")] : ["tailscale"];
  for (const command of commands) {
    try { return JSON.parse((await run(command, ["status", "--json"], { windowsHide: true, timeout: 2500, maxBuffer: 2_000_000 })).stdout); }
    catch { /* Try the Windows installation path; never expose peer data or credentials. */ }
  }
}
/** Only this computer's name is exposed. No tailnet inventory leaves the backend. */
export function hostInfo(directory: string, read = readTailscale, computer = hostname()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "host-id");
  try { writeFileSync(file, randomUUID(), { flag: "wx", mode: 0o600 }); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
  const id = readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid local host-id file");
  let cached: HostSource | undefined, expires = 0, pending: Promise<HostSource> | undefined;
  return async (): Promise<HostSource> => {
    if (cached && Date.now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      let name: string | undefined;
      try { name = tailscaleName(await read()); } catch {}
      cached = { id, name: name || computer, nameSource: name ? "tailscale" : "hostname",
        ...(!name ? { warning: "Tailscale device name unavailable; using the computer hostname." } : {}) };
      expires = Date.now() + 60_000; return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
