import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { dataDirectory } from "../config.js";
import { validateCwd } from "../../../../packages/pi-runtime/sessions.js";
import { codexTerminal } from "./codex-terminal.js";
import { claudeTerminal } from "./claude-terminal.js";

const { values } = parseArgs({ options: { tunnel: { type: "string" }, cwd: { type: "string" },
  resume: { type: "string" }, fresh: { type: "boolean" }, name: { type: "string" }, help: { type: "boolean" } } });
if (values.help) {
  console.log("Even-Pilot native connector\n--tunnel codex|claude --cwd <project> [--resume <native session ID>]");
} else {
  try {
    if (values.tunnel !== "codex" && values.tunnel !== "claude") throw new Error("Choose --tunnel codex or claude");
    if (values.resume && !/^[a-f0-9-]{16,64}$/i.test(values.resume)) throw new Error("Use a native session ID");
    const cwd = await validateCwd(resolve(values.cwd || process.cwd()));
    const options = { data: dataDirectory(), cwd, id: values.resume, resume: !!values.resume && !values.fresh };
    if (values.tunnel === "codex") await codexTerminal({ ...options, id: values.fresh ? undefined : options.id,
      launchId: values.fresh ? options.id : undefined, name: values.name }); else await claudeTerminal(options);
  } catch (error) {
    console.error("[Even-Pilot] " + (error instanceof Error ? error.message : "Connector could not start"));
    process.exitCode = 1;
  }
}
