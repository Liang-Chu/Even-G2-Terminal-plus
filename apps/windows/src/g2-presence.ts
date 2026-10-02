import { SessionError } from "../../../packages/pi-runtime/sessions.js";

export const G2_VIEW_LEASE_MS = 15_000;
interface View { sequence: number; key?: string; expires: number; retainUntil: number }

/** Ephemeral viewing leases are separate from durable Watch membership. */
export class G2Presence {
  private views = new Map<string, View>();
  constructor(private now = Date.now) {}
  update(data: Record<string, unknown>) {
    const { clientId, sequence, sessionKey } = data;
    if (typeof clientId !== "string" || !/^[a-f0-9]{32}$/.test(clientId)
      || !Number.isSafeInteger(sequence) || (sequence as number) < 1
      || (sessionKey !== null && (typeof sessionKey !== "string" || !/^[a-f0-9]{32}$/.test(sessionKey))))
      throw new SessionError("Invalid glasses viewing report");
    const now = this.now();
    for (const [id, view] of this.views) if (view.retainUntil <= now) this.views.delete(id);
    const previous = this.views.get(clientId);
    if (previous && previous.sequence >= (sequence as number)) return;
    if (!previous && this.views.size >= 64) throw new SessionError("Too many glasses viewers", 429);
    // Keep release tombstones longer than any in-flight heartbeat request.
    this.views.set(clientId, { sequence: sequence as number, key: typeof sessionKey === "string" ? sessionKey : undefined,
      expires: now + G2_VIEW_LEASE_MS, retainUntil: now + 60_000 });
  }
  viewing(key?: string): boolean {
    return !!key && [...this.views.values()].some(view => view.key === key && view.expires > this.now());
  }
}
