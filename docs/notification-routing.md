# Notification routing

Each computer can send directly to Glance or forward completion events to one center. This works on Windows and Linux. Configure/import your own Firebase project in the phone's Glance app using the [Glance README](https://github.com/Liang-Chu/Glance#readme). Every sender must target that same project. Start with [first-time notification setup](setup.md#optional-glance-notifications) / [中文配置](setup.zh-CN.md#可选-glance-通知).

Adding a computer in phone **Connection** saves phone access to its sessions. The desktop manager controls only its own computer. Neither action registers Glance or changes notification routing. **Glance notifications** is a separate dialog: desktop settings affect only the local source; on the phone, **Computer** selects a saved source.

## Independent sending

1. Configure FCM credentials on every sending computer, following [Glance push](glance-push.md).
2. Add a PUSH watcher in Glance for each computer's `http://<address>:4317/api/glance` URL and its connection key.
3. Open **Glance notifications** on each source's desktop, or select that source in phone **Computer**. Set **Send notifications → Directly from this computer**, then **Save notification settings**. Repeat for each source.

On a Linux sender:

```sh
terminal-plus settings push direct
terminal-plus settings firebase --credentials /private/glance-sender.json
terminal-plus settings
terminal-plus pair
```

The service-account JSON must authorize FCM sending for the phone's Glance project. The Linux command derives the target from its `project_id`, saves that project and a private file reference, and restarts only monitoring; native CLIs keep running. For an authorized cross-project service account or ADC, set `EVEN_PILOT_FCM_PROJECT_ID` to the phone's target in the monitoring process/service environment. Android `google-services.json` is not a sending credential, and no private Firebase credentials are included in Terminal+ packages. The final `pair` displays this sender's URL/key/QR for Glance registration, which is still a separate phone operation.

## One center

1. Install/update Terminal+ on the server and other computers. Keep the center reachable from every source, for example through Tailscale.
2. Configure FCM credentials only on the center using the commands above or [Windows sender setup](glance-push.md#windows-setup). The center uses **Directly from this computer** and can still monitor its own sessions.
3. To configure from the phone, save both center and source in phone **Connection**.
4. Open phone **Glance notifications**. Choose the source in **Computer**, set **Send notifications → Through a central computer**, select **Central computer**, then **Save notification settings**. Repeat for other source computers.
5. In Glance, edit the old watcher or create one PUSH watcher with the center's complete `/api/glance` URL and **the center's connection key**, then **Save and register**. Disable/remove other independent watchers if they are no longer needed. No Android APK update is needed for this routing feature.

To configure from a source's desktop instead, open **Glance notifications**, choose **Through a central computer**, enter **Center URL** (`http://CENTER_IP:4317`) and **Center connection key**, then **Save notification settings**. The desktop source is fixed to this computer. This does not add the center to session viewing; the center control key is used only for registration, is not saved by the UI and clears when the dialog closes. An existing center URL is prefilled; keeping the same center needs no key and preserves that route's queued events. The source backend retains only the dedicated relay credential.

On each Linux source, after the center is ready:

```sh
terminal-plus settings push forward --url http://CENTER_IP:4317 --key-file /private/center-key.txt
terminal-plus settings
```

Replace `CENTER_IP`. The private file contains only the center's plain connection key; do not place it on the command line or in shared files. Registration obtains a dedicated relay credential. The source does not need Firebase credentials or a Glance registration of its own. To switch back, use `terminal-plus settings push direct`; then configure and register this computer as an independent sender.

The **Glance watcher** URL in the dialog follows the source for direct delivery or the selected center for forwarding. It is information to enter in Glance, not an automatic registration. Opening settings only reads configuration; routing changes require an explicit save.

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
