# Bridge API requirements

All `/api/*` routes require `Authorization: Bearer <key>`. JSON requests use `Content-Type: application/json`. Query-string credentials are rejected. Body limit: 128 KB; prompt limit: 32,000 characters. The shared QR key can access every route. The legacy notification-only key can access only Glance/completion routes.

Multi-computer clients keep one connection/key per backend. Namespaced session keys in the UI are client-side only: each request still goes directly to its source backend with that backend's original 32-character key. Never send a different computer's credential or the UI-scoped key to these endpoints. `/api/host` reports only this computer, not the Tailscale peer list.

| Method / path | Purpose |
| --- | --- |
| `GET /api/host` | Control key only; persistent host `id`, display `name`, `nameSource` (`tailscale` or `hostname`) and optional fallback `warning`. No peer inventory or credentials. |
| `GET /api/pairing` | `{version:1,url,registrationUrl,image}`; image is PNG data URL |
| `GET /api/monitoring` | Running/watched counts, session states and `nativeTerminals` mode |
| `GET /api/sessions?cwd=...` | Saved/live sessions by descending `updatedAt`; optional absolute project filter |
| `POST /api/session/resume` | `{key}` selects existing native terminal or opens the original saved session and monitors it |
| `POST /api/session/new` | Optional `{cwd,name,tunnel}` opens a native terminal; tunnel is `pi`, `codex` or `claude`, cwd must exist |
| `POST /api/runtime/:key/monitor` | `{monitored:true/false}` changes membership only; never opens, interrupts or closes a native terminal |
| `POST /api/desktop/open` | `{openId:"<UUID>"}` applies rolling 24-hour Watch defaults once per explicit manager opening; reusing the latest ID preserves manual changes, including across backend restart |
| `POST /api/runtime/:key/terminal` | Open/reuse native terminal and monitor it |
| `GET /api/state`, `GET /api/runtime/:key/state` | Selected/specified live state |
| `GET /api/events`, `GET /api/runtime/:key/events` | Shared/session-specific SSE |
| `POST /api/prompt`, `POST /api/runtime/:key/prompt` | `{text}` relays prompt to selected/specified native terminal; selected endpoint accepts `sessionKey` and returns 409 if selection changed |
| `POST /api/runtime/:key/interrupt` | Interrupt the specified session's current run; changed/idle runs are rejected by the connector |
| `GET /api/sessions/:key/history` | Bounded saved history for phone use; no session changes |
| `POST /api/interaction/respond` | `{sessionKey,requestId,answers,cancel?}` answers a current structured request; see [connectors](connectors.md) |
| `POST /api/glance` | Existing push registration/removal or polling contract; see [push specification](glance-push.md) |
| `POST /api/g2/view` | Control key; `{clientId,sequence,sessionKey}` reports the currently mounted G2 conversation; `sessionKey:null` releases it. Client ID is 32 lowercase hex characters, sequence a positive increasing integer. Heartbeat every 5 seconds, lease 15 seconds, never changes Watch. |
| `GET /api/glance/push` | Push configuration/subscription metadata and recent send status |
| `POST /api/glance/push/test` | Validate or explicitly queue a test; control key required |
| `GET /api/completions?after=0` | Non-consuming retained completion history |
| `POST /api/shutdown` | Stop this backend; native terminal windows continue |

Session listing returns `{sessions: [...], skipped: number}`. Entries contain opaque `key`, `id`, `cwd`, optional `name`/`preview`/`model`, epoch-millisecond `updatedAt`, `runtimeStatus`, `active`, `monitored` and optional `live`. Do not supply file paths as keys. Discovery uses `~/.pi/agent/sessions` or `PI_CODING_AGENT_DIR`; `--session-dir` and `PI_CODING_AGENT_SESSION_DIR` add flat directories.

A successful prompt response means delivery acceptance, not completion. Timeout leaves delivery uncertain: check the terminal before retrying. Commands expire after five seconds and are claimed before execution; reconnect does not replay them. Error shape: `{error:string}`. Codes: 400 invalid input, 401 credentials, 403 scope/origin, 404 unknown session, 409 busy/not ready, 504 unconfirmed terminal delivery.

SSE uses `fetch` with authorization. Reconnect sends current state and retained completion events after `Last-Event-ID`/`after`. State replaces the prior snapshot. Heartbeats arrive every 15 seconds. Connection loss does not change monitored membership. Visible messages and tool names/outcomes are exposed; thinking and raw tool results are excluded. Structured approvals include the operation preview needed for user consent.

One backend owns a data directory at a time. `.local` holds private credentials, monitoring membership, native snapshots/commands and notification state. Do not commit it. `EVEN_PILOT_DATA_DIR` must agree between Pi extension and backend when using isolated deployments. Stable tokens come from `.local/bridge-config.json` or `EVEN_PILOT_TOKEN` / `EVEN_PILOT_NOTIFICATION_TOKEN`. HTTP is for a trusted LAN/Tailscale. A paired WebView authenticates with the bearer key. API CORS reflects its origin only after authentication; preflight permits the authorization header but grants no API access. No cookie credentials are accepted. Static content still uses the origin restrictions (`--allow-origin`). HTTPS pages require a compatible HTTPS bridge to avoid mixed-content blocking.

