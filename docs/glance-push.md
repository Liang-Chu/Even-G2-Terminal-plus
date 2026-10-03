# Glance FCM push

For a first-time user, start with [notification setup](setup.md#optional-glance-notifications) / [中文配置](setup.zh-CN.md#可选-glance-通知), which includes exact Linux settings commands, Windows configuration and phone registration. Use [notification routing](notification-routing.md) to choose independent senders or one center. This page is the detailed backend/diagnostic reference.

Even-Pilot sends a notification when **each monitored session** finishes its main run and reported subagents. Session A notifies when A settles, even while B continues running. A reported interruption or failure produces that outcome; disconnection or closing a native terminal is not completion. Intermediate replies, tool completion, reconnect, initial idle and session browsing do not trigger a push. Remaining idle does not send repeated notifications. Unwatch never closes or interrupts the native terminal; temporary network loss retains monitoring membership.

The desktop observes native Pi, Codex and Claude sessions. Existing Pi terminals attach with `/reload` while idle; plain Codex CLI and local Codex desktop App sessions use the automatic read-only rollout observer. Ordinary Claude uses official monitor hooks installed during preparation, beginning with its next prompt; known custom Stop hooks or uncertain background work prevent an unconfirmed completion push. See [connector limits](connectors.md). Automatic PUSH and POLL notifications are suppressed for a session while its conversation or voice page is mounted on G2. Other watched sessions notify normally. Phone/desktop preview alone does not suppress delivery. Opening Sessions, switching away, or exiting releases the view; a lost heartbeat expires after 15 seconds. This ephemeral lease never changes Watch membership. Suppressed completion records remain in history and are never replayed as notifications. Explicit test pushes remain available while viewing.

## Windows setup

Use **your own Firebase project**, configured/imported on the phone through the [Glance setup guide](https://github.com/Liang-Chu/Glance#readme). The sender's target project ID must match that phone configuration. Glance supports user-configured projects; you do not need to rebuild its APK. The sender needs ADC or a service account authorized to send FCM for the target project. Android `google-services.json` configures the client and cannot authorize a server.

A new installation generates its own bridge credentials but has **no Firebase sending credentials**. Core monitoring works without them; push sending does not. Configure credentials only on each direct sender or the central sender, and never distribute private service-account JSON in release assets. Each user supplies credentials authorized for their phone's target Firebase project.

For an installed Windows companion, add the Firebase fields shown below to its existing `.local/bridge-config.json` at the installation root, preserving the keys. Use an absolute credential-file path. Restart the monitoring backend using the [manual update shutdown steps](development.md#更新已有安装), then open Even-Pilot again; quitting only the tray does not reload the backend. No system Node or npm is required. In the current payload folder, the optional credential check uses the bundled runtime:

```powershell
.\runtime\node.exe --import tsx .\apps\windows\src\push-cli.ts check-auth
```

Linux users can configure the sender with `even-pilot settings firebase --credentials /private/service-account.json`. It saves the JSON's `project_id` as the target and the private file path as the credential reference, then restarts only monitoring. That project must match the phone's Glance configuration. See [Linux settings](linux.md#推送与-firebase-设置).

The following npm commands are **source-checkout diagnostics**, requiring the development Node/npm environment:

```powershell
npm run push -- check-auth
npm start
```

The desktop session picker selects the original session in its native terminal. LAN/Tailscale access is enabled by default, so no `--host` flag is required.

For a source checkout or another explicitly managed process environment, use these overrides:

```powershell
$env:EVEN_PILOT_FCM_PROJECT_ID = 'YOUR_FIREBASE_PROJECT_ID'
$env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\private\firebase-service-account.json'
$env:EVEN_PILOT_TOKEN = '<existing-control-token-at-least-24-characters>'
$env:EVEN_PILOT_NOTIFICATION_TOKEN = '<different-glance-token-at-least-24-characters>'
$env:EVEN_PILOT_PUSH_TTL_SECONDS = '30' # Optional, default 30; integer 1–3600
npm start
```

Or add the Firebase fields to the generated `.local/bridge-config.json`, preserving its existing keys (paths resolve against the project root):

```json
{
  "controlToken": "<your-control-token>",
  "notificationToken": "<your-different-glance-token>",
  "firebaseProjectId": "YOUR_FIREBASE_PROJECT_ID",
  "firebaseCredentialsPath": "C:\\private\\firebase-service-account.json"
}
```

Replace `YOUR_FIREBASE_PROJECT_ID` with the actual project ID imported/configured in Glance, not its display name. Environment variables take precedence; `.env` files are not auto-loaded. On hosted Google infrastructure you may omit the credential path and use workload identity/ADC. A service account from a different project also works if authorized to send for the target; explicitly set `firebaseProjectId` or `EVEN_PILOT_FCM_PROJECT_ID` to that target. Without a Firebase project configuration, registration remains available but sends are disabled and jobs record `FCM_NOT_CONFIGURED`.

Enable the Firebase Cloud Messaging API in the target project and grant the sending service account FCM send permission there (the Firebase Cloud Messaging API Admin role is Google's documented option). `check-auth` verifies OAuth credential authentication without exposing the token; it does **not** prove project-level send permission or phone delivery.

## Glance connection

1. Install compatible Glance and configure/import your Firebase project using its [README](https://github.com/Liang-Chu/Glance#readme). Configure the sender for that same target project.
2. Keep the phone and sender/center reachable over Tailscale or a trusted local network.
3. Create/edit a watcher and choose **DELIVERY: PUSH**.
4. Registration URL: your current **Bridge URL** plus **`/api/glance`**, for example `http://<PC-IP>:4317/api/glance`. Enter the complete URL; Glance appends nothing.
5. Credential: the same **connection key** used by Even Hub, without `Bearer ` in the field. The [shared v1 QR](glance-qr-v1.md) fills the URL and key. Existing notification-only credentials also remain valid. Never use a Firebase private key as this field.
6. Suggested limits: body 80, title 32; start with a 10-second display time for testing. Tap **SAVE AND REGISTER**; expect **REGISTERED FOR PUSH**.
7. Allow Android notifications for Glance. Enable Glance notification forwarding in the Even app to see them on G2.

HTTP is for trusted local testing, including this private Tailscale setup. Use HTTPS outside that environment. The PC must stay awake and the backend must keep running. The phone must have working Google Play services and an FCM connection; phone-to-PC Tailscale reachability alone does not establish Google connectivity.

## Registration API

The same exact **POST `/api/glance`** URL handles registration and removal. Both accept the existing Glance credential or the control credential with `Authorization: Bearer <credential>` and `Content-Type: application/json`.

```json
{
  "operation": "register_push",
  "subscription_id": "watcher-subscription-id",
  "installation_id": "phone-firebase-installation-id",
  "firebase_project_id": "YOUR_FIREBASE_PROJECT_ID",
  "watcher": "Pi on my PC",
  "max_length": 80,
  "title_max_length": 32,
  "expires_after_seconds": 10,
  "client": "Glance"
}
```

Registration upserts only that subscription ID, including its installation ID, name and limits. Several watchers can share a phone; one registration never replaces the other watchers. Successful registration returns **204 with no body**, never notification content. No polling interval is needed. New subscriptions start with future completion events, without replaying old completions.

For PUSH registration, Glance supplies `firebase_project_id` from its imported phone configuration. When a sender project is configured, this field is required and must match it; a missing or different project is rejected. An unconfigured sender still accepts registration but cannot send until Firebase is configured. Use the phone's actual project ID in the example, not the placeholder.

```json
{ "operation": "unregister_push", "subscription_id": "watcher-subscription-id", "client": "Glance" }
```

Removal also returns **204 with no body**, including repeated removal and unknown IDs. A durable tombstone prevents late registration of a removed ID (**410**). Removing a watcher cancels its pending/retry jobs and aborts an in-flight request where possible. A message already accepted by FCM cannot be recalled; Glance disables routing for retired IDs. Other watchers remain registered.

IDs accept 1–200 ASCII letters, digits, `_`, `.`, `:` and `-`. Watcher names accept 1–128 UTF-16 code units, title/body limits are integers 1–10000, display expiry is an integer 1–86400 seconds. This is a single-owner desktop bridge: both authorized credentials operate the same owner's subscriptions. It does not implement multi-user accounts.

Requests without `operation` keep the existing polling contract: 200 with content or 204 when empty. Polling and push cursors are independent. If you configure two watchers for the same event, each can notify independently.

## Test and inspect

Offline payload validation, with no Firebase connection or credentials needed:

```powershell
npm run push -- dry-run --title 'Even-Pilot' --text 'Push test complete.'
npm run push -- dry-run --title 'OK' --text '😀!' --max-length 3
```

Inspect the running server, select one of its subscription IDs, then send one explicit test notification:

```powershell
npm run push -- status
npm run push -- test --subscription <id> --title 'Even-Pilot' --text 'FCM connection test.' --dry-run
npm run push -- test --subscription <id> --title 'Even-Pilot' --text 'FCM connection test.'
npm run push -- status
```

These live commands use the control token from `EVEN_PILOT_TOKEN` or the local configuration. They call the running bridge; they do not concurrently edit its storage. `--url http://<PC-IP>:4317` selects another bridge. Test commands accept `--priority HIGH|NORMAL` and `--ttl <seconds>`; use HIGH for timely user-visible alerts and NORMAL for other updates.

Control-only API: **GET `/api/glance/push`** returns configuration, subscription metadata and recent job statuses, without FIDs, message bodies or credentials. **POST `/api/glance/push/test`** accepts `subscription_id`, `title`, `text`, optional `priority`, `ttl_seconds`, and `dry_run`. A dry run returns 200 `validated_locally`; a real test returns 202 `queued` with a `jobId`. The Glance notification credential receives 403 on these diagnostic/test endpoints.

After a successful explicit test, run a harmless prompt through Even-Pilot and observe RUNNING → IDLE. Expect one new job for each registered watcher. With two sessions running, verify that the first session notifies without waiting for the second. Repeat while the G2 app is closed to verify Even's forwarding behavior. FCM acceptance and a phone/G2 notification are separate observations.

## Delivery behavior and failures

The sender uses authenticated HTTP v1 at `https://fcm.googleapis.com/v1/projects/YOUR_FIREBASE_PROJECT_ID/messages:send`, with the configured target project ID. The data-only payload contains `message.fid`, `data.subscription_id`, `data.title`, `data.text`, and Android priority/TTL. All data values are strings. There is no `notification` object, topic routing, registration-token substitution, or second push to clear a notification.

Explicit title/body inputs must be nonempty and fit the subscription's UTF-16 code-unit limits, including emoji. Oversize explicit inputs are rejected without changing their content. The entire JSON envelope must fit 4096 UTF-8 bytes. Since 0.4.1, automatic completion messages are composed within each watcher's limits: long session names use a shortened label and short session ID, small title budgets use `Pi` or `π`, and very small body budgets retain a compact outcome. Unicode surrogate pairs are preserved. The final FCM boundary remains strict for both generated and explicit content.

FCM queue TTL defaults to 30 seconds and shrinks on retry/authentication delays. It controls freshness in transit; `expires_after_seconds` is Glance's local display lifetime. The backend does not send expiry messages.

`.local/glance-push.json` persists subscriptions, retirement tombstones, completion cursors and pending jobs. An exclusive backend lock is acquired before loading writable state, and the HTTP listener is reserved before activating the push worker or restoring Pi sessions. Repeated CLI launches reuse the existing backend. Writes use atomic replacement. Up to 100 active subscriptions, 500 queued/in-flight jobs and 200 terminal job records are retained; tombstones are never evicted automatically. Do not delete this file as a retry strategy: that would lose retirement protection and duplicate suppression.

| State/code | Meaning and action |
| --- | --- |
| `queued` / `sending` | A send is pending/in progress; no delivery assertion. |
| `accepted` | FCM accepted the request. Phone/G2 receipt remains unconfirmed. |
| `FCM_UNREGISTERED` / `FCM_INVALID_FID` | This subscription is disabled. Register its refreshed installation address. Other watchers remain active. |
| `FCM_CREDENTIALS_UNAVAILABLE` / `FCM_AUTHORIZATION_FAILED` | Sending is blocked for this process. Check credentials, project/API permissions, then restart. |
| `FCM_UNAVAILABLE` / `FCM_RATE_LIMITED` | At most 3 attempts, exponential backoff with jitter, honoring Retry-After and freshness. Rate limiting waits at least 60 seconds, so the default 30-second alert expires instead. |
| `expired` | Too old to send/retry; no stale alert is sent. |
| `uncertain` | Response lost or process restarted during a send. It may already have been accepted; no automatic replay. |
| `cancelled` | Subscription was removed or disabled before another send. |
| `PUSH_STORAGE_FAILED` | Sending stops if state cannot be safely persisted; inspect the local file/disk before restart. |

Accepted sends are not intentionally replayed. FCM is best-effort; there is no phone delivery acknowledgement or exactly-once guarantee. Raw Firebase/auth errors and credentials are not returned to the API or logs.

References: [Glance contract](https://github.com/Liang-Chu/Glance), [FCM message schema](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages), [server authorization](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [FCM errors](https://firebase.google.com/docs/cloud-messaging/error-codes), [network requirements](https://firebase.google.com/docs/cloud-messaging/network-configuration).
