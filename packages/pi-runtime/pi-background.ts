import { constants, closeSync, existsSync, openSync, opendirSync, readSync } from "node:fs";
import { join, posix } from "node:path";

export interface PiBackgroundSession {
  pid: number;
  sessionId: string;
  sessionFile: string;
  /** Other known native Pi owners are windows, rather than background jobs. */
  excludePids?: readonly number[];
}
export interface PiBackgroundState { active: number; uncertain?: true }
interface Binding { pid: number; started: string; sessionId: string; sessionFile: string; uncertain?: true }
interface Options {
  directory?: string;
  uid?: number;
  selfPid?: number;
  now?: () => number;
  maxProcesses?: number;
}
const CACHE_MS = 1000;
const ENV_BYTES = 64 * 1024;
const MAX_PROCESSES = 4096;

/** A full bounded read; /proc files commonly report size zero before reading. */
function boundedRead(path: string, limit: number): Buffer | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const buffer = Buffer.allocUnsafe(limit);
    let length = 0;
    while (length < limit) {
      const received = readSync(descriptor, buffer, length, limit - length, null);
      if (!received) return buffer.subarray(0, length);
      length += received;
    }
    // An oversized environment is not read further or interpreted partially.
    return;
  } catch { return; }
  finally { if (descriptor !== undefined) try { closeSync(descriptor); } catch {} }
}

function processState(path: string): { started: string; live: boolean } | undefined {
  const value = boundedRead(join(path, "stat"), 4096)?.toString("utf8");
  if (!value) return;
  const end = value.lastIndexOf(")");
  if (end < 0) return;
  const fields = value.slice(end + 1).trim().split(/\s+/);
  const started = fields[19];
  if (!/^[A-Za-z]$/.test(fields[0] || "") || !/^\d+$/.test(started || "")) return;
  return { started, live: !["Z", "X", "x"].includes(fields[0]) };
}

function sameUser(path: string, uid: number): boolean | undefined {
  const value = boundedRead(join(path, "status"), 16 * 1024)?.toString("utf8");
  if (value === undefined) return;
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(value);
  if (!match) return;
  return match.slice(1).every(value => Number(value) === uid);
}

function sessionPath(value: string): string | undefined {
  return value && value.length <= 4096 && posix.isAbsolute(value) && !value.includes("\0")
    ? posix.normalize(value) : undefined;
}

/** Extract only public session identity; never retain raw environment content. */
function environmentBinding(buffer: Buffer): { sessionId: string; sessionFile: string } | undefined {
  let sessionId: string | undefined, sessionFile: string | undefined;
  let from = 0;
  while (from < buffer.length) {
    const to = buffer.indexOf(0, from);
    if (to < 0) return;
    const equal = buffer.indexOf(61, from);
    if (equal >= from && equal < to) {
      const key = buffer.subarray(from, equal).toString("ascii");
      if (key === "PI_SESSION_ID" || key === "PI_SESSION_FILE") {
        const value = buffer.subarray(equal + 1, to).toString("utf8");
        if (value.includes("\uFFFD")) return;
        if (key === "PI_SESSION_ID") {
          if (sessionId !== undefined || !value || value.length > 200) return;
          sessionId = value;
        } else {
          if (sessionFile !== undefined) return;
          sessionFile = sessionPath(value);
          if (!sessionFile) return;
        }
      }
    }
    from = to + 1;
  }
  return sessionId && sessionFile ? { sessionId, sessionFile } : undefined;
}

/** Read-only Linux observation of modern Pi's inherited session environment.
 * Detached jobs count as work, not agents. Old Pi/third-party jobs without both
 * identity variables cannot be safely associated with a watched session.
 */
export class PiBackgroundScanner {
  private readonly directory: string;
  private readonly uid: number | undefined;
  private readonly selfPid: number;
  private readonly now: () => number;
  private readonly maxProcesses: number;
  private at = -Infinity;
  private bindings = new Map<number, Binding>();
  private incomplete = false;
  constructor(options: Options = {}) {
    this.directory = options.directory || "/proc";
    this.uid = options.uid ?? process.getuid?.();
    this.selfPid = options.selfPid ?? process.pid;
    this.now = options.now || Date.now;
    this.maxProcesses = Math.min(MAX_PROCESSES, Math.max(1, options.maxProcesses || MAX_PROCESSES));
  }
  scan(session: PiBackgroundSession, forceRefresh = false): PiBackgroundState {
    const path = sessionPath(session.sessionFile);
    if (this.uid === undefined || !session.sessionId || !path) return { active: 0 };
    const now = this.now();
    if (forceRefresh || now < this.at || now - this.at >= CACHE_MS) this.refresh(now);
    const excluded = new Set([session.pid, this.selfPid, ...(session.excludePids || [])]);
    let active = 0, uncertain = this.incomplete;
    for (const binding of this.bindings.values()) {
      if (excluded.has(binding.pid) || binding.sessionId !== session.sessionId || binding.sessionFile !== path) continue;
      if (binding.uncertain) uncertain = true;
      else active++;
    }
    return { active, ...(uncertain ? { uncertain: true as const } : {}) };
  }
  private refresh(now: number) {
    const previous = this.bindings, next = new Map<number, Binding>();
    this.at = now;
    this.incomplete = false;
    let directory: ReturnType<typeof opendirSync> | undefined;
    try {
      directory = opendirSync(this.directory);
      let count = 0;
      for (let entry; (entry = directory.readSync());) {
        if (!/^\d+$/.test(entry.name)) continue;
        if (++count > this.maxProcesses) { this.incomplete = true; break; }
        const pid = Number(entry.name);
        if (!Number.isSafeInteger(pid) || pid < 1 || pid === this.selfPid) continue;
        const path = join(this.directory, entry.name), old = previous.get(pid), state = processState(path);
        if (!state) {
          if (old && existsSync(path) && sameUser(path, this.uid!) !== false) next.set(pid, { ...old, uncertain: true });
          continue;
        }
        if (!state.live) continue;
        const user = sameUser(path, this.uid!);
        if (user === false) continue;
        if (user === undefined) {
          if (old?.started === state.started) next.set(pid, { ...old, uncertain: true });
          continue;
        }
        const environment = boundedRead(join(path, "environ"), ENV_BYTES);
        const binding = environment && environmentBinding(environment);
        // Recheck identity after reading to exclude exits and reused PIDs.
        const current = processState(path);
        if (!current) {
          if (old?.started === state.started && existsSync(path)) next.set(pid, { ...old, uncertain: true });
          continue;
        }
        if (!current.live || current.started !== state.started) continue;
        if (binding) next.set(pid, { pid, started: state.started, ...binding });
        else if (environment === undefined && old?.started === state.started) next.set(pid, { ...old, uncertain: true });
      }
    } catch { this.incomplete = true; }
    finally { try { directory?.closeSync(); } catch {} }
    this.bindings = next;
  }
}
