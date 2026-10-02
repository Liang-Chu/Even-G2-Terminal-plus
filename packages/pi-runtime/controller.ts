import type { CockpitStore } from "../cockpit-state/store.js";
import type { Tunnel } from "../cockpit-state/types.js";
import type { SessionHistory, SessionSummary } from "./sessions.js";

/** Public monitoring/control surface; no process ownership implied. */
export interface RuntimeController {
  store: CockpitStore;
  concurrentSessions?: boolean;
  prompt(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  listSessions(cwd?: string): Promise<{ sessions: SessionSummary[]; skipped: number }>;
  sessionHistory(key: string): Promise<SessionHistory>;
  newSession(options?: { cwd?: string; name?: string; tunnel?: Tunnel }): Promise<unknown>;
  resumeSession(key: string): Promise<void>;
}
