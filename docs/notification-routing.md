# Notification routing

Each computer can send directly to Glance or forward completion events to one center. This works on Windows and Linux; use matching 1.1.1 companions.

## Independent sending

1. Configure FCM credentials on every sending computer, following [Glance push](glance-push.md).
2. Add a PUSH watcher in Glance for each computer's `http://<address>:4317/api/glance` URL and its connection key.
3. In Even-Pilot, open **Connection / Bridge settings → Glance notifications → Notification routing**. Select each computer and choose **Send directly from this computer**.

## One center

1. Install/update Even-Pilot on the server and other computers. Keep the center reachable from every source, for example through Tailscale.
2. Configure FCM credentials only on the center. The center uses **Send directly from this computer** and can still monitor its own sessions.
3. Save both the center and the source in Hub or the desktop management page's Connection settings.
4. Open **Notification routing**, select a source computer, choose **Forward via <center name>**, then save. Repeat for other source computers.
5. In Glance, edit the old watcher or create one PUSH watcher with the center's complete `/api/glance` URL and **the center's connection key**, then **Save and register**. Disable/remove other independent watchers if they are no longer needed. No Android APK update is needed for this routing feature.

The source keeps monitoring even when the phone is closed. Forwarding is server-to-server; the phone is not a relay. Notifications include the source device and session name. G2 viewing suppression is decided on the source before forwarding. Temporary disconnects do not cancel Watch or create completion events.

Sources queue completions for up to ten minutes, retry in order, and persist their queue across restarts. The center persists each source's event cursor with the received event before acknowledging it; retrying a lost acknowledgement does not create another completion. FCM still has its own accepted/failed/uncertain delivery states; center acceptance is not proof the phone displayed a notification. Events older than ten minutes expire. Changing routes cancels pending events for the old route and never replays older history.

Sources store only a dedicated relay credential, not the center's terminal-control key or Firebase credentials. The center stores its hash. This credential only probes/forwards notifications and cannot read conversations, run prompts, or change Watch. Disconnect a source from the center's routing settings to revoke it. A center receiving other sources cannot itself forward elsewhere; disconnect its sources first. Relay chains and self-forwarding are rejected.

## API

Control-key endpoints:

| Method/path | Body/result |
| --- | --- |
| `GET /api/glance/routing` | Mode, public target identity/URL, FCM readiness, incoming sources, queue count and last result. No relay key returned. |
| `POST /api/glance/routing` | `{ "mode": "direct" }` or `{ "mode": "relay", "target": { "id", "name", "url", "key" } }`; verifies the target before saving. |
| `POST /api/glance/relay/register` | Center receives `{ "sourceId", "sourceName" }`; returns its `{ "id", "name", "key" }`. Treat this response as a secret. |
| `POST /api/glance/relay/revoke` | Center receives `{ "sourceId" }`. |

Dedicated relay-key endpoints:

| Method/path | Body/result |
| --- | --- |
| `POST /api/glance/relay/probe` | `{}` → center identity and readiness. |
| `POST /api/glance/relay/event` | `{ "event": { "id", "at", "session", "sessionId"?, "outcome", "forwardTo" } }` → acknowledgement. Source id/name come from the credential, not arbitrary event data. |

`notification-routing.json` and `notifications.json` are private runtime data. Never publish them. Back up these files with the bridge configuration; keep the source's host identity stable so retries can be deduplicated.
