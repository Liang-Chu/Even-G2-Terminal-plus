import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, unlink, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ensureLocalConfig, dataDirectory } from "../../windows/src/config.js";
import { installMonitorExtension, prepareMonitorExtensions } from "../../windows/src/install-extension.js";
import { preferredPairOrigin, printPairingQr } from "../../windows/src/pairing.js";
import { processAlive, readLocalJson } from "../../../packages/pi-runtime/native-protocol.js";
import { executable } from "./platform.js";
import { runSessionCommand, sessionCommands, sessionHelp } from "./session-cli.js";
import { monitorRunning } from "./monitor-health.js";
import { runSettingsCommand, settingsHelp } from "./settings-cli.js";

const run = promisify(execFile);
const payload = fileURLToPath(new URL("../../../", import.meta.url));
const data = dataDirectory();
const unitName = process.env.EVEN_PILOT_SERVICE_NAME || "even-pilot.service";
if (!/^[a-zA-Z0-9_-]+\.service$/.test(unitName)) throw new Error("Invalid service name");
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const unitPath = join(configHome, "systemd/user", unitName);
const autoPath = join(configHome, "autostart/even-pilot.desktop");
const port = Number(process.env.EVEN_PILOT_PORT || 4317);
if (process.platform !== "linux") throw new Error("This launcher is for Linux");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid EVEN_PILOT_PORT");
const origin = "http://127.0.0.1:" + port;
const firebaseOverrides = { GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  EVEN_PILOT_FCM_PROJECT_ID: process.env.EVEN_PILOT_FCM_PROJECT_ID };
const config = ensureLocalConfig();
const token = process.env.EVEN_PILOT_TOKEN || config.controlToken!;
const [command = "open", ...args] = process.argv.slice(2);
const systemdQuote = (text: string, expand = false) => '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", expand ? "$$" : "$").replaceAll("\n", "\\n").replaceAll("\r", "\\r") + '"';
const desktopQuote = (text: string) => '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$").replaceAll("%", "%%") + '"';
const loader = new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const backend = fileURLToPath(new URL("../../windows/src/cli.ts", import.meta.url));
const launcher = join(payload, "bin/even-pilot");
const marker = "# Even-PIlot managed user service";
const dataMarker = "# Even-PIlot data: " + JSON.stringify(data);
async function request(path: string, post?: object, timeoutMs = 2500) {
  return fetch(origin + path, { method: post ? "POST" : "GET", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Connection: "close" },
    body: post ? JSON.stringify(post) : undefined, signal: AbortSignal.timeout(timeoutMs) });
}
async function running() {
  return monitorRunning(() => request("/api/monitoring"), port);
}
async function hasSystemd() { if (process.env.EVEN_PILOT_NO_SYSTEMD === "1") return false; try { await run("systemctl", ["--user", "show-environment"], { timeout: 3000 }); return true; } catch { return false; } }
async function ownUnit() { try { return (await readFile(unitPath, "utf8")).startsWith(marker + "\n" + dataMarker + "\n"); } catch { return false; } }
async function service() {
  try { if (!(await readFile(unitPath, "utf8")).startsWith(marker + "\n" + dataMarker + "\n")) throw new Error("A service for another installation already exists"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(unitPath), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, EVEN_PILOT_DATA_DIR: data };
  const names = ["PATH", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "EVEN_PILOT_DATA_DIR", "EVEN_PILOT_PORT", "EVEN_PILOT_TERMINAL",
    "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "EVEN_PILOT_PI", "EVEN_PILOT_CODEX", "EVEN_PILOT_CLAUDE",
    "GOOGLE_APPLICATION_CREDENTIALS", "EVEN_PILOT_FCM_PROJECT_ID", "EVEN_PILOT_PUSH_TTL_SECONDS", "EVEN_PILOT_TOKEN", "EVEN_PILOT_NOTIFICATION_TOKEN"];
  const environment = names.filter(name => env[name] !== undefined).map(name => "Environment=" + systemdQuote(name + "=" + env[name])).join("\n");
  await writeFile(unitPath, `${marker}\n${dataMarker}\n[Unit]\nDescription=Even-Pilot session monitor\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=%h\n${environment}\nExecStart=/usr/bin/env -- ${[process.execPath, "--import", loader, backend, "--port", String(port)].map(value => systemdQuote(value, true)).join(" ")}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=20\nKillMode=process\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
  await chmod(unitPath, 0o600);
  await run("systemctl", ["--user", "link", unitPath]);
  await run("systemctl", ["--user", "daemon-reload"]);
}
async function start() {
  if (await running()) return;
  installMonitorExtension();
  if (await hasSystemd()) { await service(); await run("systemctl", ["--user", "start", unitName]); }
  else {
    const child = spawn(process.execPath, ["--import", loader, backend, "--port", String(port)], {
      cwd: homedir(), env: { ...process.env, EVEN_PILOT_DATA_DIR: data }, detached: true, stdio: "ignore", shell: false });
    await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); }); child.unref();
  }
  for (let n = 0; n < 100; n++) { if (await running()) return; await delay(200); }
  throw new Error("Backend did not become ready. Check journalctl --user -u even-pilot.service");
}
async function stop() {
  if (await running()) {
    const response = await request("/api/shutdown", {}); if (!response.ok) throw new Error("The monitor refused shutdown");
    for (let n = 0; n < 100; n++) { if (!await running()) break; await delay(100); }
    if (await running()) throw new Error("Monitor did not exit; native terminals were not stopped");
  }
  if (await ownUnit() && await hasSystemd()) {
    const state = await run("systemctl", ["--user", "show", "--property=LoadState", "--value", unitName]);
    if (state.stdout.trim() !== "not-found") await run("systemctl", ["--user", "stop", unitName]);
  }
}
async function autostart(enabled: boolean) {
  if (await hasSystemd()) {
    await service(); await run("systemctl", ["--user", enabled ? "enable" : "disable", unitPath]);
    // `disable` also removes links for a custom XDG_CONFIG_HOME. Keep the unit
    // definition loaded (including KillMode) while disabling only login start.
    if (!enabled) { await run("systemctl", ["--user", "link", unitPath]); await run("systemctl", ["--user", "daemon-reload"]); }
  } else if (enabled) {
    await mkdir(dirname(autoPath), { recursive: true });
    let existing: string | undefined; try { existing = await readFile(autoPath, "utf8"); } catch {}
    if (existing && !existing.includes("X-Even-PIlot=true")) throw new Error("Unrelated autostart entry exists");
    await writeFile(autoPath, `[Desktop Entry]\nType=Application\nName=Even-Pilot\nExec=${desktopQuote(launcher)} start\nTerminal=false\nX-Even-PIlot=true\n`, { mode: 0o600 });
  } else { try { if ((await readFile(autoPath, "utf8")).includes("X-Even-PIlot=true")) await unlink(autoPath); } catch {} }
}
async function nativeAlive() {
  for (const name of await readdir(join(data, "native")).catch(() => [])) {
    const pid = Number(name.replace(/\.json$/, "")); if (!Number.isSafeInteger(pid) || !processAlive(pid)) continue;
    try { if (readLocalJson(join(data, "native", name)).state.connected) return true; } catch { return true; }
  }
  return false;
}
try {
  if (sessionCommands.has(command)) { await runSessionCommand(command, args, { request, write: console.log }); }
  else if (command === "settings") {
    if (!args.includes("--help") && !args.includes("-h")) await start();
    await runSettingsCommand(args, { request, write: console.log, directory: data, env: firebaseOverrides,
      restart: async () => {
        await stop();
        if (!firebaseOverrides.GOOGLE_APPLICATION_CREDENTIALS) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        ensureLocalConfig(); await start();
      } });
  }
  else if (command === "start") { await start(); console.log("Even-Pilot background is running."); }
  else if (command === "stop") { await stop(); console.log("Monitoring stopped. Native terminals remain running."); }
  else if (command === "restart") { await stop(); await start(); console.log("Monitoring restarted. Native terminals remain running."); }
  else if (command === "status") {
    if (!await running()) console.log("Background stopped. Watch settings retained.");
    else { const state = await (await request("/api/monitoring")).json() as any; console.log(`Background running · ${state.running} running / ${state.watched} watched`); }
  } else if (command === "update") {
    if (args.length > 1 || args[0] && !["check", "on", "off", "status"].includes(args[0])) throw new Error("Usage: even-pilot update [check|on|off|status]");
    await start();
    const action = args[0];
    const response = action === "on" || action === "off" ? await request("/api/updates/settings", { automaticChecks: action === "on" })
      : action === "status" ? await request("/api/updates") : await request("/api/updates/check", {}, 20_000);
    const status = await response.json() as any;
    if (!response.ok) throw new Error(status.error || "Update request failed");
    console.log(`Even-Pilot ${status.currentVersion} · automatic updates ${status.automaticChecks ? "on" : "off"}`);
    if (status.error) {
      if (action !== "status") throw new Error(status.error);
      console.log("Update error: " + status.error);
    }
    if (action === "status") console.log(`Update state: ${status.phase}${status.phase === "downloading" ? ` (${status.progress}%)` : ""}`);
    if (status.available) {
      console.log(`Available: ${status.available.version}`);
      if (!action) {
        const install = await request("/api/updates/install", { version: status.available.version });
        const result = await install.json() as any;
        if (!install.ok) throw new Error(result.error || "Update could not start");
        console.log("Downloading and updating in the background. Native terminals keep running. Use even-pilot update status to check the result.");
      }
    } else if (action === "check" || !action) console.log("No newer release available.");
    if (status.lastResult) console.log(`Last update: ${status.lastResult.status} (${status.lastResult.version})`);
  } else if (command === "autostart") {
    if (!["on", "off"].includes(args[0])) throw new Error("Usage: even-pilot autostart on|off");
    await autostart(args[0] === "on"); console.log("Autostart " + args[0]);
  } else if (command === "prepare") { prepareMonitorExtensions(); }
  else if (command === "uninstall-check") { if (await nativeAlive()) throw new Error("Close connected CLI terminals before uninstalling. No terminal was stopped."); }
  else if (command === "remove-service") {
    await stop();
    if (await ownUnit()) { if (await hasSystemd()) await run("systemctl", ["--user", "disable", unitPath]); await unlink(unitPath); if (await hasSystemd()) await run("systemctl", ["--user", "daemon-reload"]); }
    try { if ((await readFile(autoPath, "utf8")).includes("X-Even-PIlot=true")) await unlink(autoPath); } catch {}
  } else if (command === "pair") {
    const phoneOrigin = preferredPairOrigin("0.0.0.0", port);
    console.log("Bridge URL: " + (phoneOrigin || origin));
    console.log("Connection key: " + token);
    if (phoneOrigin) {
      console.log("Glance URL: " + new URL("/api/glance", phoneOrigin).href);
      console.log("\nScan in Glance, then Save and register (PUSH).\n");
      printPairingQr(phoneOrigin, token);
    } else console.log("Phone QR unavailable: connect LAN or Tailscale, then run even-pilot pair again.");
  } else if (command === "open") {
    await start();
    const response = await request("/api/desktop/open", { openId: randomUUID() }); if (!response.ok) throw new Error("Could not apply watch defaults");
    const open = await executable("xdg-open");
    if (open && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
      const child = spawn(open, [origin + "/?desktop=1#pilot-token=" + encodeURIComponent(token)], { detached: true, stdio: "ignore", shell: false });
      await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); }); child.unref();
    } else console.log("Open this private manager link in your browser:\n" + (preferredPairOrigin("0.0.0.0", port) || origin) + "/?desktop=1#pilot-token=" + encodeURIComponent(token));
  } else if (command === "enable-pi-subagents") {
    const child = spawn(process.execPath, ["--import", loader, join(payload, "scripts/enable-pi-subagents.mjs")], { stdio: "inherit", shell: false });
    process.exitCode = await new Promise<number>((done, fail) => { child.once("error", fail); child.once("exit", code => done(code || 0)); });
  } else if (command === "uninstall") {
    const child = spawn(process.execPath, [join(payload, "apps/linux/install.mjs"), "--uninstall", ...args], { stdio: "inherit", shell: false });
    process.exitCode = await new Promise<number>((done, fail) => { child.once("error", fail); child.once("exit", code => done(code || 0)); });
  } else if (["help", "--help", "-h"].includes(command)) {
    console.log("even-pilot — Linux session watcher\n\nBackground: start | stop | restart | status | autostart on|off\nUpdates: update (install latest) | update check|on|off|status\nConnection: pair (prints URL/key/QR) | open (optional browser)\nSettings: settings (push routing / Firebase; settings --help)\nOptional Pi setup: enable-pi-subagents\nRemove application: uninstall\n\n" + sessionHelp + "\n\n" + settingsHelp);
  } else throw new Error("Unknown command. Run `even-pilot --help`.");
} catch (error) { console.error("[Even-Pilot] " + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
