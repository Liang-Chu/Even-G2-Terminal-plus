import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";

interface LocalConfig {
  controlToken?: string;
  notificationToken?: string;
  firebaseProjectId?: string;
  firebaseCredentialsPath?: string;
}
const payloadRoot = fileURLToPath(new URL("../../../", import.meta.url));
export function installationRoot() {
  const payload = resolve(payloadRoot);
  if (!existsSync(resolve(payload, "installed.json"))) return payload;
  if (basename(dirname(payload)) !== "versions") throw new Error("Invalid installed application layout");
  return dirname(dirname(payload));
}
export const dataDirectory = () => resolve(process.env.EVEN_PILOT_DATA_DIR || (process.platform === "linux"
  ? resolve(process.env.XDG_DATA_HOME || resolve(homedir(), ".local/share"), "even-pilot") : resolve(installationRoot(), ".local")));

/** Optional local settings; environment variables override them. Never echo their contents. */
export function loadLocalConfig(directory = dataDirectory()): LocalConfig {
  const root = installationRoot();
  const path = resolve(directory, "bridge-config.json");
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    for (const key of ["controlToken", "notificationToken", "firebaseProjectId", "firebaseCredentialsPath"])
      if (data[key] !== undefined && (typeof data[key] !== "string" || !data[key].trim())) throw new Error();
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && data.firebaseCredentialsPath)
      process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(root, data.firebaseCredentialsPath);
    return data;
  } catch { throw new Error("Invalid .local/bridge-config.json; check the local configuration without sharing secrets"); }
}

/** First launch creates private, persistent pairing keys; never replace existing settings. */
export function ensureLocalConfig(directory = dataDirectory()): LocalConfig {
  const path = resolve(directory, "bridge-config.json");
  if (!existsSync(path)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const config = { controlToken: randomBytes(24).toString("base64url"), notificationToken: randomBytes(24).toString("base64url") };
    try { writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
  }
  const config = loadLocalConfig(directory);
  const control = process.env.EVEN_PILOT_TOKEN || config.controlToken;
  const notification = process.env.EVEN_PILOT_NOTIFICATION_TOKEN || config.notificationToken;
  if (!control || !notification || control.length < 24 || notification.length < 24 || control === notification)
    throw new Error("Configure distinct controlToken and notificationToken values of at least 24 characters in .local/bridge-config.json");
  return config;
}
