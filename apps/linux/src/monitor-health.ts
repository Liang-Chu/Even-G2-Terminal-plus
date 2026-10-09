import { setTimeout as delay } from "node:timers/promises";

// Only the read-only health probe retries. A shutdown can close a socket between
// accepting the probe and returning headers, or briefly keep accepting requests
// after readiness becomes false. Neither case permits retrying a mutation.
export async function monitorRunning(probe: () => Promise<Response>, port: number): Promise<boolean> {
  const lifecycleDeadline = Date.now() + 5000;
  let lifecycleRetries = 0, socketRetries = 0;
  for (;;) {
    try {
      const response = await probe();
      if (!response.ok) {
        if (response.status === 503) {
          // The bridge emits this exact body during its lifecycle.
          // Consume it before retrying; an unrelated or malformed 503 stays fatal.
          const body = await response.json().catch(() => null);
          if (body && typeof body === "object" && Object.keys(body).length === 1 &&
            body.error === "Bridge is starting or shutting down; retry shortly") {
            if (lifecycleRetries >= 50 || Date.now() >= lifecycleDeadline) {
              throw new Error("Bridge on port " + port + " is still starting or shutting down. Try again shortly; no process was stopped.");
            }
            lifecycleRetries++;
            await delay(100);
            continue;
          }
        }
        throw new Error("Port " + port + " is occupied by another bridge. No process was stopped.");
      }
      return (await response.json()).nativeTerminals === true;
    } catch (error: any) {
      const code = error.cause?.code || error.code;
      if (code === "ECONNREFUSED") return false;
      if (socketRetries < 2 && ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) {
        socketRetries++; await delay(100); continue;
      }
      throw error;
    }
  }
}
