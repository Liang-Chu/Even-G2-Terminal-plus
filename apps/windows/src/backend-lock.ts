import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";

export class BackendAlreadyRunning extends Error {
  constructor() { super("Another Even-Pilot backend already owns this data directory"); }
}

/** Kernel-owned IPC listener: exclusive across CLI/tray processes and released even after a crash. */
export async function acquireBackendLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  const id = createHash("sha256").update(process.platform === "win32" ? actual.toLowerCase() : actual).digest("hex");
  const path = process.platform === "win32" ? `\\\\.\\pipe\\even-pilot-${id}`
    : process.platform === "linux" ? `\0even-pilot-${id}` : undefined;
  if (!path) throw new Error("Backend locking currently supports Windows and Linux");
  const lock = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    lock.once("error", (error: NodeJS.ErrnoException) => {
      lock.close(() => reject(error.code === "EADDRINUSE" ? new BackendAlreadyRunning() : error));
    });
    lock.listen({ path, exclusive: true }, resolve);
  });
  return () => new Promise<void>((resolve, reject) => lock.close(error => error ? reject(error) : resolve()));
}
