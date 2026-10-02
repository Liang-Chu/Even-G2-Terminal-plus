import { CockpitStore } from "../../packages/cockpit-state/store.js";
import type { RuntimeController } from "../../packages/pi-runtime/controller.js";
import type { SessionHistory } from "../../packages/pi-runtime/sessions.js";
import { sessionLabel } from "../../packages/cockpit-state/selectors.js";

export function completeSession(store: CockpitStore, outcome: "completed" | "interrupted" | "failed" = "completed") {
  store.dispatch({ type: "monitoring.settled", session: sessionLabel(store.state),
    sessionKey: store.state.session.key, sessionId: store.state.session.id, outcome });
}

/** Transport tests drive state explicitly; they never launch an agent. */
export class TestRuntime implements RuntimeController {
  readonly store: CockpitStore;
  constructor(options: { cwd: string }) { this.store = new CockpitStore(options.cwd); }
  async prompt(): Promise<void> { throw new Error("No terminal in this transport fixture"); }
  async interrupt(): Promise<void> { throw new Error("No terminal in this transport fixture"); }
  async listSessions() { return { sessions: [], skipped: 0 }; }
  async sessionHistory(): Promise<SessionHistory> { throw new Error("No session in this transport fixture"); }
  async newSession(): Promise<void> { throw new Error("No terminal in this transport fixture"); }
  async resumeSession(): Promise<void> { throw new Error("No terminal in this transport fixture"); }
}
