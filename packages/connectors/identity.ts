import { createHash } from "node:crypto";
import type { Tunnel } from "../cockpit-state/types.js";
export function connectorKey(tunnel: Exclude<Tunnel, "pi">, id: string) {
  return createHash("sha256").update(tunnel + ":" + id).digest("hex").slice(0, 32);
}
export const isTunnel = (value: unknown): value is Tunnel => value === "pi" || value === "codex" || value === "claude";
