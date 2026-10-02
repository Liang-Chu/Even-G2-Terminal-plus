import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export function installMonitorExtension() {
  const target = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "extensions", "even-pilot-monitor.ts");
  const marker = "// Even-PIlot native terminal monitor\n";
  if (existsSync(target) && !readFileSync(target, "utf8").startsWith(marker)) throw new Error("An unrelated even-pilot-monitor.ts already exists; choose another extension filename");
  const source = fileURLToPath(new URL("./pi-extension.ts", import.meta.url)).replace(/\\/g, "/");
  const content = marker + `export { default } from ${JSON.stringify(source)};\n`;
  if (!existsSync(target) || readFileSync(target, "utf8") !== content) {
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  return target;
}
