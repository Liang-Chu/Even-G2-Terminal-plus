import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The tray owns only this short-lived launcher. The backend has no pipes or
// console tied to the tray, and continues serving existing session windows.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), ...process.argv.slice(2)], {
  cwd: root, detached: true, windowsHide: true, stdio: "ignore", shell: false,
});
await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
child.unref();
