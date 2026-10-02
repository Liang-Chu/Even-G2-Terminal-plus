import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeState } from "../cockpit-state/types.js";

export interface NativeSnapshot {
  version: 1;
  instance: string;
  pid: number;
  terminalPid?: number;
  launchId?: string;
  at: number;
  updatedAt: number;
  sessionFile?: string;
  runId: number;
  completions: { id: number; at: number; outcome: "completed" | "interrupted" | "failed" }[];
  state: RuntimeState;
}
export interface NativeCommand {
  id: string; instance: string; key: string; expiresAt: number;
  type: "prompt" | "interrupt" | "respond"; text?: string; runId?: number;
  answer?: import("../cockpit-state/interactions.js").InteractionAnswer;
}
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function readLocalJson(path: string): any {
  if (statSync(path).size > 512_000) throw new Error("Local bridge file exceeds its size limit");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function writeLocalJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
export function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
