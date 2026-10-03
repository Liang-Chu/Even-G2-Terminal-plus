import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NotificationJournal } from "./notifications.js";
import { createBridgeServer, type ServerOptions } from "./server.js";
import { hostInfo } from "./host-info.js";
import { preferredPairOrigin } from "./pairing.js";
import { GlancePush } from "./push.js";
import { FcmSender, validateFirebaseProjectId } from "./fcm.js";
import { ensureLocalConfig, dataDirectory } from "./config.js";
import { acquireBackendLock, BackendAlreadyRunning } from "./backend-lock.js";
import { NativeHost } from "../../../packages/pi-runtime/native-host.js";
import { openNativeTerminal, hasUnregisteredTerminal } from "./native-terminal.js";
import { installMonitorExtension } from "./install-extension.js";
import { ConnectorCatalog } from "../../../packages/connectors/catalog.js";
import { NotificationRelay } from "./notification-relay.js";
import { UpdateService } from "./updates.js";
import { installationRoot } from "./config.js";
import { readFileSync } from "node:fs";

const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    host: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: "4317" },
    "allow-origin": { type: "string", multiple: true },
    "pair-url": { type: "string" },
    resume: { type: "string" },
    "session-dir": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Even-Pilot monitoring backend

--cwd <project>       Default project directory
--host <address>      Default 0.0.0.0 (LAN/Tailscale)
--port <number>       Default 4317
--pair-url <origin>   Override phone connection address
--resume <key>        Select/open a discovered native session
--session-dir <path>  Additional Pi session directory
--allow-origin <url>  Additional allowed WebView origin

Run pi/codex normally, or open a native terminal from the desktop manager.
Connection URL and key are available in the desktop pairing panel.`);
  process.exit(0);
}
const cwd = resolve(values.cwd || process.cwd());
const sessions = { directories: values["session-dir"] ? [resolve(values["session-dir"])] : [] };
let runtime: NativeHost;
let releaseLock: (() => Promise<void>) | undefined;
let ready = false;
let closeBridge: (() => Promise<void>) | undefined;
let journal: NotificationJournal | undefined;
let push: GlancePush | undefined;
let relay: NotificationRelay | undefined;
let updates: UpdateService | undefined;
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  ready = false;
  await updates?.close();
  await relay?.close();
  await push?.close();
  await runtime?.stop();
  await closeBridge?.();
  journal?.close();
  await releaseLock?.(); releaseLock = undefined;
}
const onSignal = () => { void shutdown(); };
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
try {
  releaseLock = await acquireBackendLock(dataDirectory());
  runtime = new NativeHost({ cwd, sessions, directory: resolve(dataDirectory(), "native"),
    catalog: new ConnectorCatalog({ data: dataDirectory(), pi: sessions }), codexObservation: {},
    claudeObservation: { directory: resolve(dataDirectory(), "claude-events") },
    preferencesPath: resolve(dataDirectory(), "monitoring.json"), launch: openNativeTerminal, unregistered: hasUnregisteredTerminal });
  const localConfig = ensureLocalConfig();
  const token =
    process.env.EVEN_PILOT_TOKEN || localConfig.controlToken;
  const notificationToken =
    process.env.EVEN_PILOT_NOTIFICATION_TOKEN ||
    localConfig.notificationToken;
  if (
    !token || !notificationToken || token.length < 24 ||
    notificationToken.length < 24 ||
    token === notificationToken
  )
    throw new Error(
      "Use different control and notification tokens, each at least 24 characters",
    );
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  journal = new NotificationJournal(
    runtime.store,
    resolve(dataDirectory(), "notifications.json"),
  );
  const projectId = process.env.EVEN_PILOT_FCM_PROJECT_ID || localConfig.firebaseProjectId;
  if (projectId) validateFirebaseProjectId(projectId);
  const serverOptions: ServerOptions = {
    token,
    notificationToken,
    hostInfo: hostInfo(dataDirectory()),
    isReady: () => ready,
    host: runtime,
    pairOrigin: values["pair-url"] || preferredPairOrigin(values.host!, port),
    shutdown,
    allowedOrigins: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      ...(values["allow-origin"] || []),
    ],
    staticDir: fileURLToPath(new URL("../../evenhub/dist", import.meta.url)),
  };
  const bridge = createBridgeServer(runtime, journal, serverOptions);
  closeBridge = bridge.close;
  await new Promise<void>((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(port, values.host, resolve);
  });
  // Own both data and listening socket before restoring sessions or activating persisted push work.
  relay = new NotificationRelay(journal, { path: resolve(dataDirectory(), "notification-routing.json"),
    identity: await serverOptions.hostInfo!(), canSend: () => Boolean(push?.status().configured) });
  serverOptions.relay = relay;
  installMonitorExtension();
  await runtime.start();
  if (values.resume) await runtime.resumeSession(values.resume);
  if (exiting) throw new Error("Backend startup was cancelled");
  push = new GlancePush(journal, {
    path: resolve(dataDirectory(), "glance-push.json"),
    projectId, sender: projectId ? new FcmSender(projectId) : undefined,
    ttlSeconds: Number(process.env.EVEN_PILOT_PUSH_TTL_SECONDS || "30"),
    diagnostic: message => console.error(`[push] ${message}`),
  });
  serverOptions.push = push;
  const payloadRoot = fileURLToPath(new URL("../../../", import.meta.url));
  updates = new UpdateService({ directory: dataDirectory(), installRoot: installationRoot(), payloadRoot,
    version: JSON.parse(readFileSync(resolve(payloadRoot, "package.json"), "utf8")).version, port });
  serverOptions.updates = updates;
  ready = true;
  console.log(`[push] ${projectId ? `FCM project ${projectId}; server credentials verified on first send` : "Registration enabled; sending disabled until EVEN_PILOT_FCM_PROJECT_ID and ADC are configured"}`);
  console.log(`[bridge] http://127.0.0.1:${port} · listening on ${values.host}:${port}`);
  console.log("[pair] Open Phone URL & key in the desktop manager. Credentials are not written to logs.");
} catch (error) {
  await shutdown();
  process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  if (error instanceof BackendAlreadyRunning || (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.log("[bridge] Another backend is already running; existing sessions and settings are unchanged.");
  } else {
    console.error(`[error] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
