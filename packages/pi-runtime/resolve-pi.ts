import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

export interface PiCommand {
  command: string;
  args: string[];
}
export function resolvePi(
  executable = process.env.EVEN_PILOT_PI || "pi",
): PiCommand {
  const isPath = isAbsolute(executable) || /[\\/]/.test(executable);
  const directories = isPath
    ? [dirname(resolve(executable))]
    : (process.env.PATH || "").split(delimiter);
  const packages = [
    "@earendil-works/pi-coding-agent",
    "@mariozechner/pi-coding-agent",
  ];
  if (isPath && /\.[cm]?js$/i.test(executable) && existsSync(executable))
    return { command: process.execPath, args: [resolve(executable)] };
  for (const directory of directories) {
    const candidate = isPath
      ? resolve(executable)
      : join(
          directory,
          process.platform === "win32" ? `${executable}.exe` : executable,
        );
    if (existsSync(candidate) && !/\.(cmd|ps1|bat)$/i.test(candidate)) {
      const resolved = realpathSync(candidate);
      return /\.[cm]?js$/i.test(extname(resolved))
        ? { command: process.execPath, args: [resolved] }
        : { command: candidate, args: [] };
    }
    // Resolve npm's package bin rather than spawning a Windows shell or parsing its shim.
    for (const name of packages) {
      const root = join(directory, "node_modules", name);
      try {
        const pkg = JSON.parse(
          readFileSync(join(root, "package.json"), "utf8"),
        );
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
        if (bin && existsSync(join(root, bin)))
          return { command: process.execPath, args: [join(root, bin)] };
      } catch {
        /* This PATH entry is not a Pi installation. */
      }
    }
  }
  throw new Error(
    "Pi was not found. Install Pi, or set EVEN_PILOT_PI to its executable or CLI .js file.",
  );
}
