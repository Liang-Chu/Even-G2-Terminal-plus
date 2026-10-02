import { setTimeout as delay } from "node:timers/promises";

// Only the read-only health probe retries. A shutdown can close a socket between
// accepting the probe and returning headers; do not treat that as a CLI failure
// or blindly retry a mutating request.
export async function monitorRunning(probe: () => Promise<Response>, port: number): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await probe();
      if (!response.ok) throw new Error("Port " + port + " is occupied by another bridge. No process was stopped.");
      return (await response.json()).nativeTerminals === true;
    } catch (error: any) {
      const code = error.cause?.code || error.code;
      if (code === "ECONNREFUSED") return false;
      if (attempt < 2 && ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) { await delay(100); continue; }
      throw error;
    }
  }
}
