import { parseArgs } from "node:util";
import { constants } from "node:fs";
import { open, realpath, stat, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createPrivateKey, randomUUID } from "node:crypto";
import { validateFirebaseProjectId } from "../../windows/src/fcm.js";

type Request = (path: string, body?: object, timeoutMs?: number) => Promise<Response>;
type RemoteRequest = (origin: string, path: string, token: string, body: object) => Promise<Response>;
export interface SettingsContext {
  request: Request; write: (line: string) => void; directory: string; restart: () => Promise<void>;
  env?: Partial<Pick<NodeJS.ProcessEnv, "GOOGLE_APPLICATION_CREDENTIALS" | "EVEN_PILOT_FCM_PROJECT_ID">>;
  remoteRequest?: RemoteRequest;
}
export const settingsHelp = `Headless notification settings:
  settings                                    Show delivery and sender status
  settings push direct                        Send from this computer
  settings push forward --url URL --key-file FILE
                                              Forward to one configured center
  settings firebase --credentials FILE        Use a Firebase service-account JSON
  settings firebase clear                     Remove the saved credentials reference

The center connection key is read from FILE, never a command-line token.
Firebase changes restart only monitoring; native CLI sessions keep running.
GOOGLE_APPLICATION_CREDENTIALS and EVEN_PILOT_FCM_PROJECT_ID override saved settings.`;

const safeName = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const identity = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
function relayOrigin(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new Error("Enter a center HTTP(S) origin without credentials, path, query or fragment."); }
}

/** Resolve symlinks once, then verify the opened regular file before bounded reads. */
async function privateFile(path: string, limit: number, kind: string) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!path.trim() || /[\u0000-\u001f\u007f]/.test(path)) throw new Error();
    const canonical = await realpath(resolve(path));
    const before = await stat(canonical);
    if (!before.isFile() || before.size < 1 || before.size > limit) throw new Error();
    file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used <= limit) {
      const read = await file.read(buffer, used, buffer.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (!used || used > limit) throw new Error();
    const text = buffer.subarray(0, used).toString("utf8"); buffer.fill(0);
    return { path: canonical, text };
  } catch { throw new Error(`Cannot read ${kind}: choose a regular readable file within its size limit.`); }
  finally { await file?.close().catch(() => {}); }
}
async function credentials(path: string) {
  const file = await privateFile(path, 128_000, "Firebase credentials");
  try {
    const value = JSON.parse(file.text);
    const projectId = validateFirebaseProjectId(value?.project_id);
    if (value?.type !== "service_account" ||
      typeof value.client_email !== "string" || !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(value.client_email) ||
      typeof value.private_key !== "string" || value.private_key.length > 16_000 ||
      value.token_uri !== undefined && value.token_uri !== "https://oauth2.googleapis.com/token" ||
      value.universe_domain !== undefined && value.universe_domain !== "googleapis.com") throw new Error();
    const key = createPrivateKey(value.private_key);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error();
    return { path: file.path, projectId };
  } catch { throw new Error("Choose a valid Firebase service-account JSON with its project ID and RSA private key."); }
}
async function savedConfig(directory: string): Promise<Record<string, unknown>> {
  const path = join(resolve(directory), "bridge-config.json");
  try { await stat(path); }
  catch (error: any) { if (error.code === "ENOENT") return {}; throw new Error("Cannot read saved bridge configuration."); }
  const file = await privateFile(path, 64_000, "saved bridge configuration");
  try {
    const data = JSON.parse(file.text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new Error("Saved bridge configuration is invalid. Repair it before changing settings."); }
}
async function saveConfig(directory: string, value: Record<string, unknown>) {
  const root = resolve(directory), path = join(root, "bridge-config.json"), temporary = path + "." + randomUUID() + ".tmp";
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); await file.close(); file = undefined;
    await rename(temporary, path);
  } catch { throw new Error("Could not save bridge configuration. Existing settings were retained."); }
  finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
async function result(response: Response, kind: string) {
  if (!response.ok) throw new Error(`${kind} failed (HTTP ${response.status}). Check connection, permissions and sender settings.`);
  try { return await response.json() as any; }
  catch { throw new Error(`${kind} returned an unreadable reply. Check settings before retrying.`); }
}
function environmentNote(context: SettingsContext) {
  const env = context.env || process.env;
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.EVEN_PILOT_FCM_PROJECT_ID)
    context.write("Environment overrides are active: GOOGLE_APPLICATION_CREDENTIALS or EVEN_PILOT_FCM_PROJECT_ID can override saved Firebase settings.");
}
const remote: RemoteRequest = (origin, path, token, body) => fetch(origin + path, {
  method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify(body), signal: AbortSignal.timeout(12_000), credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
});

export async function runSettingsCommand(args: string[], context: SettingsContext) {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args, allowPositionals: true, options: {
    url: { type: "string" }, "key-file": { type: "string" }, credentials: { type: "string" }, help: { type: "boolean", short: "h" },
  } }); }
  catch { throw new Error("Invalid settings arguments. Run `terminal-plus settings --help`."); }
  const { positionals, values } = parsed;
  if (values.help) { context.write(settingsHelp); return; }
  const action = positionals.join(" "), names = Object.keys(values);
  const valid = (!action && !names.length) || action === "push direct" && !names.length ||
    action === "push forward" && names.length === 2 && typeof values.url === "string" && typeof values["key-file"] === "string" ||
    action === "firebase" && names.length === 1 && typeof values.credentials === "string" || action === "firebase clear" && !names.length;
  if (!valid) throw new Error("Invalid settings arguments. Run `terminal-plus settings --help`.");
  const api = async (path: string, body?: object) => {
    let response: Response;
    try { response = await context.request(path, body, 15_000); }
    catch { throw new Error(body ? "Settings request was not confirmed. Check settings before retrying; nothing was resent." : "Cannot reach monitoring. Run `terminal-plus start`, then try again."); }
    return result(response, "Settings request");
  };
  if (!action) {
    const [routing, push] = await Promise.all([api("/api/glance/routing"), api("/api/glance/push")]);
    if (!["direct", "relay"].includes(routing?.mode) || typeof push?.configured !== "boolean" || !Array.isArray(push.subscriptions))
      throw new Error("Invalid settings reply from monitoring.");
    context.write(routing.mode === "relay" ? `Delivery: forwarding${safeName(routing.target?.name) ? " via " + routing.target.name : " to a center"}` : "Delivery: direct from this computer");
    context.write(`Firebase sender: ${push.configured ? "configured" : "not configured"} · Glance PUSH watchers: ${push.subscriptions.length}`);
    environmentNote(context); return;
  }
  if (action === "push direct") {
    await api("/api/glance/routing", { mode: "direct" }); context.write("Direct notification delivery saved."); return;
  }
  if (action === "push forward") {
    const origin = relayOrigin(values.url as string), key = (await privateFile(values["key-file"] as string, 4096, "center connection key")).text.trim();
    if (key.length < 24 || key.length > 512 || /[\u0000-\u0020\u007f-\u009f]/.test(key)) throw new Error("The center connection-key file must contain one valid connection key.");
    const source = await api("/api/host");
    if (!identity(source?.id) || !safeName(source?.name)) throw new Error("Invalid source identity returned by monitoring.");
    let response: Response;
    try { response = await (context.remoteRequest || remote)(origin, "/api/glance/relay/register", key, { sourceId: source.id, sourceName: source.name }); }
    catch { throw new Error("Center registration was not confirmed. Check the center before retrying; nothing was resent."); }
    const peer = await result(response, "Center registration");
    if (!identity(peer?.id) || peer.id === source.id || !safeName(peer?.name) || typeof peer?.key !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(peer.key))
      throw new Error("Invalid center registration reply. Notification routing was not changed.");
    await api("/api/glance/routing", { mode: "relay", target: { id: peer.id, name: peer.name, url: origin, key: peer.key } });
    context.write("Notification forwarding saved. Register Glance PUSH on the center."); return;
  }
  const credential = action === "firebase" ? await credentials(values.credentials as string) : undefined;
  const config = await savedConfig(context.directory);
  if (credential) { config.firebaseProjectId = credential.projectId; config.firebaseCredentialsPath = credential.path; }
  else { delete config.firebaseProjectId; delete config.firebaseCredentialsPath; }
  await saveConfig(context.directory, config);
  context.write(credential ? "Firebase credential reference saved." : "Saved Firebase credential reference removed; the key file was retained.");
  environmentNote(context);
  try { await context.restart(); }
  catch { throw new Error("Settings were saved, but monitoring restart was not confirmed. Run `terminal-plus restart`; native CLI sessions were not stopped."); }
  context.write("Monitoring restarted. Native CLI sessions remain running.");
}
