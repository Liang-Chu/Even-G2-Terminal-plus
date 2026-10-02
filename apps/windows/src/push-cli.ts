import { parseArgs } from "node:util";
import { buildPushPayload, type PushSubscription } from "./push.js";
import { loadLocalConfig } from "./config.js";
import { GoogleAuth } from "google-auth-library";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  url: { type: "string", default: "http://127.0.0.1:4317" },
  subscription: { type: "string" }, title: { type: "string", default: "Even-Pilot" },
  text: { type: "string", default: "Push test complete." },
  "max-length": { type: "string", default: "80" }, "title-max-length": { type: "string", default: "32" },
  priority: { type: "string", default: "HIGH" }, ttl: { type: "string", default: "30" },
  "dry-run": { type: "boolean" }, help: { type: "boolean" },
} });
async function main() {
  const command = positionals[0] || "dry-run";
  if (values.help) {
    console.log("npm run push -- dry-run [--title text --text text --max-length 80 --title-max-length 32]\nnpm run push -- check-auth\nnpm run push -- status\nnpm run push -- test --subscription <id> --title <title> --text <text> [--dry-run]\nLive commands use EVEN_PILOT_TOKEN or .local/bridge-config.json (control credential) and --url <bridge-origin>.");
    return;
  }
  if (command === "dry-run") {
    const maxLength = Number(values["max-length"]), titleMaxLength = Number(values["title-max-length"]);
    if (![maxLength, titleMaxLength].every(n => Number.isInteger(n) && n >= 1 && n <= 10_000)) throw new Error("Length limits must be integers from 1 to 10000");
    const subscription: PushSubscription = { id: "local-dry-run", installationId: "local-only-not-a-destination", watcher: "Local validation",
      maxLength, titleMaxLength, expiresAfterSeconds: 3, registeredAt: Date.now(), lastCompletionId: 0 };
    const payload = buildPushPayload(subscription, { title: values.title!, text: values.text! }, Number(values.ttl), values.priority as "HIGH" | "NORMAL");
    console.log(JSON.stringify({ status: "validated_locally", contactedFirebase: false, bytes: Buffer.byteLength(JSON.stringify(payload)), payload }, null, 2));
    return;
  }
  if (!["status", "test", "check-auth"].includes(command)) throw new Error("Use dry-run, check-auth, status or test");
  const local = loadLocalConfig();
  if (command === "check-auth") {
    const project = process.env.EVEN_PILOT_FCM_PROJECT_ID || local.firebaseProjectId;
    if (project !== "even-glance") throw new Error("Set Firebase project to even-glance");
    const timeout = setTimeout(() => { console.error("Firebase authentication timed out; no notification sent."); process.exit(1); }, 15_000);
    try {
      const token = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.messaging"] }).getAccessToken();
      if (!token) throw new Error();
      console.log("Firebase OAuth authentication succeeded for sending to even-glance. No notification sent; project sending permission and phone delivery still need a selected-subscription test.");
    } catch { throw new Error("Firebase authentication failed. Check the server credential file and access to Google; raw credential errors are suppressed."); }
    finally { clearTimeout(timeout); }
    return;
  }
  const token = process.env.EVEN_PILOT_TOKEN || local.controlToken;
  if (!token) throw new Error("Set EVEN_PILOT_TOKEN to the running bridge's control credential");
  const origin = new URL(values.url!);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("--url must be an HTTP(S) bridge origin");
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin.origin + path, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  };
  if (command === "status") { console.log(JSON.stringify(await request("/api/glance/push"), null, 2)); return; }
  if (!values.subscription) throw new Error("--subscription is required; find IDs with npm run push -- status");
  const result = await request("/api/glance/push/test", { subscription_id: values.subscription,
    title: values.title, text: values.text, priority: values.priority, ttl_seconds: Number(values.ttl), dry_run: Boolean(values["dry-run"]) });
  console.log(JSON.stringify(result, null, 2));
  if (result.jobId) console.log("Queued, not confirmed delivered. Run npm run push -- status to inspect accepted/failed/expired/uncertain.");
}
try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : "Push command failed"); process.exitCode = 1; }
