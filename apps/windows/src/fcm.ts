import { GoogleAuth } from "google-auth-library";

export type PushPriority = "HIGH" | "NORMAL";
export interface FcmPayload {
  message: {
    fid: string;
    data: { subscription_id: string; title: string; text: string };
    android: { priority: PushPriority; ttl: string };
  };
}
export type FailureKind = "destination" | "auth" | "transient" | "permanent" | "uncertain";
/** Only fixed, sanitized codes cross the FCM boundary; raw errors can contain credentials. */
export class FcmFailure extends Error {
  constructor(public kind: FailureKind, public code: string, public retryAfterMs = 0) { super(code); }
}
export interface PushSender {
  send(payload: FcmPayload, signal: AbortSignal, expiresAt?: number): Promise<{ name: string }>;
}

export function validateFirebaseProjectId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value)) throw new Error("Invalid Firebase project ID");
  return value;
}

export class FcmSender implements PushSender {
  private auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  constructor(
    readonly projectId: string,
    private http: typeof fetch = fetch,
    private accessToken: () => Promise<string | null | undefined> = () => this.auth.getAccessToken(),
  ) {
    validateFirebaseProjectId(projectId);
  }
  async send(payload: FcmPayload, signal: AbortSignal, expiresAt?: number) {
    let token: string | null | undefined;
    try {
      // Bound even ADC discovery/refresh. Do not forward SDK errors to logs or HTTP clients.
      token = await abortable(this.accessToken(), signal);
      if (!token) throw new Error();
    } catch (error) {
      const cause = error as { response?: { status?: number }; code?: string } | undefined;
      const status = cause?.response?.status ?? 0;
      if (signal.aborted || status === 429 || status >= 500 || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].includes(cause?.code || ""))
        throw new FcmFailure("transient", "FCM_AUTH_TEMPORARILY_UNAVAILABLE", status === 429 ? 60_000 : 0);
      throw new FcmFailure("auth", "FCM_CREDENTIALS_UNAVAILABLE");
    }
    if (signal.aborted) throw new FcmFailure("transient", "FCM_AUTH_TEMPORARILY_UNAVAILABLE");
    if (expiresAt !== undefined) {
      const remaining = Math.floor((expiresAt - Date.now()) / 1000);
      if (remaining < 1) throw new FcmFailure("permanent", "CONTENT_EXPIRED");
      payload = { message: { ...payload.message, android: { ...payload.message.android, ttl: `${remaining}s` } } };
    }
    let response: Response;
    try {
      response = await this.http(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // A lost response can follow acceptance. Do not replay this ambiguous attempt.
      throw new FcmFailure("uncertain", "FCM_RESPONSE_UNKNOWN");
    }
    let data: any;
    try { data = await response.json(); }
    catch {
      if (response.ok) throw new FcmFailure("uncertain", "FCM_RESPONSE_UNKNOWN");
    }
    if (response.ok) {
      if (typeof data?.name !== "string" || !/^projects\/[^/]+\/messages\/[^\s]+$/.test(data.name))
        throw new FcmFailure("uncertain", "FCM_RESPONSE_UNKNOWN");
      return { name: data.name };
    }
    const details: any[] = Array.isArray(data?.error?.details) ? data.error.details : [];
    const codes = details.filter(d => d?.["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError").map(d => d.errorCode);
    if (codes.includes("UNREGISTERED")) throw new FcmFailure("destination", "FCM_UNREGISTERED");
    if (response.status === 401 || response.status === 403 || codes.includes("SENDER_ID_MISMATCH"))
      throw new FcmFailure("auth", "FCM_AUTHORIZATION_FAILED");
    if (response.status === 429 || response.status >= 500) {
      const header = response.headers.get("retry-after");
      const retry = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
      throw new FcmFailure("transient", response.status === 429 ? "FCM_RATE_LIMITED" : "FCM_UNAVAILABLE",
        Math.max(response.status === 429 ? 60_000 : 0, Number.isFinite(retry) ? retry : 0));
    }
    const invalidFid = details.some(d => d?.["@type"] === "type.googleapis.com/google.rpc.BadRequest" &&
      Array.isArray(d.fieldViolations) && d.fieldViolations.some((v: any) => v.field === "message.fid"));
    if (response.status === 400 && invalidFid) throw new FcmFailure("destination", "FCM_INVALID_FID");
    throw new FcmFailure("permanent", "FCM_REQUEST_REJECTED");
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Aborted"));
    if (signal.aborted) { reject(new Error("Aborted")); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
