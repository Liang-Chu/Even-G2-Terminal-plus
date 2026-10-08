# Codex and Claude Code connectors

Windows and Linux have one session manager for **Pi / Codex / Claude**. Each row shows its tunnel and model. Watch, most-recent sorting, G2 navigation, voice input, G2 summary tags, and Glance notifications use the same shared implementation. Linux installation and terminal commands are in [Linux setup](linux.md).

## Start a session

1. Install and sign in to the native CLI you want to use (`codex` or `claude`). Terminal+ reuses that CLI’s local login and permissions; no additional model API key is required here.
2. Open the Terminal+ manager (the Windows shortcut or Linux application menu). Choose **+ New terminal**, select **Tunnel**, and enter the project directory. An ordinary native terminal opens.
3. For Claude, accept its **local development channel** confirmation in that terminal. This enables the Terminal+ MCP channel; it does not bypass tool approvals. Claude channels require a supported Claude account and channel access.
4. Select the session on phone/G2. Prompts go into the same native session. Keep that terminal open while using it remotely.

Already connected terminals are reused. Existing Pi terminals attach using `/reload` while idle. Ordinary Claude windows can be observed without reopening through the connector; remote input still requires that connector.

Plain `codex` launches and **local Codex desktop App sessions** are now observed automatically from `$CODEX_HOME/sessions` (default `%USERPROFILE%/.codex/sessions`). No hook installation, hook trust or extra model credential is required. The background polls appended records every 750 ms and discovers new files every 3 seconds. Explicit `task_started`, `task_complete` and `turn_aborted` records drive status/notifications; child rollouts are grouped under their parent session. The first valid file metadata defines its identity, so inherited parent metadata in a child's copied history cannot turn a child completion into a parent completion. Saved titles are read from `session_index.jsonl`. Existing histories are baselined, never replayed as notifications after a backend restart.

This supplementary adapter reads Codex's internal local rollout format, verified against CLI 0.159.1 and local desktop records. It ignores unknown records and excludes reasoning/tool-output payloads. It never modifies Codex files, resumes threads, launches windows or changes Codex settings. It is not a stable public event API and needs compatibility checks after Codex changes. Cloud/remote conversations without local rollouts are outside its scope. A crash without a terminal lifecycle record leaves the last observed run unresolved; silence is never synthesized into success. “Connected” for an observed session means the local record is readable, not proof that its original process is still alive.

**Ordinary Claude Code terminals** use official lifecycle hooks installed during companion preparation into this user's `settings.json` under `CLAUDE_CONFIG_DIR` (default `~/.claude`). The installer preserves unrelated settings, respects `disableAllHooks`, and records the exact owned handlers for update/rollback/uninstall. Backend startup does not continually rewrite the profile. The hook writes a bounded private queue and does not send prompts, interrupt tasks or call a model. The observer binds events to the native PID and process start identity, reads transcripts for display, and counts reported children and keeps background tasks/schedules as completion blockers. The next prompt after hook activation establishes monitoring; no completed history is replayed. In an already open terminal use `/hooks` to verify the settings were picked up; reopen after the task finishes if necessary. No Channels access or new model key is needed for this read-only path.

Stop runs before Claude combines all hooks' decisions. Known additional Stop/SubagentStop handlers, enabled plugins, unreadable settings or uncertain task metadata keep completion unconfirmed; no timeout, disconnect or SessionEnd is turned into success. Locally visible user/project/local/inline/managed settings are checked without executing custom code. Dynamic skill/runtime hooks and remote managed policies are not fully enumerable, so this adapter remains experimental. It is not a transactional exactly-once delivery system: a crash between committing observer state and the notification callback can lose a notification.

Existing connector-backed sessions retain prompt, control and completion ownership; the observer does not replace their working channel or send a second notification. Read-only Codex/Claude observation has `capabilities.prompt: false` and `interrupt: false`; selecting it displays observed state without opening a second writer. New terminal creation remains available. Phone command/choice operations below apply to connector-backed sessions.

Installed Windows users use **+ New terminal**; Linux also has `terminal-plus new codex --cwd /your/project` and `terminal-plus new claude --cwd /your/project`. No system Node/npm is needed for those installed entry points.

For a **source checkout** with development Node/npm installed, start a connector directly from PowerShell at the repository root:

```powershell
npm run terminal:codex -- --cwd "C:\your\project"
npm run terminal:claude -- --cwd "C:\your\project"
```

To reopen an existing session manually, append `--resume <native-session-id>`. The desktop’s session picker normally handles this for you. Optional `EVEN_PILOT_CODEX` / `EVEN_PILOT_CLAUDE` environment variables can point to a native executable or package JS entry if PATH discovery fails.

## Lifecycle

- Each session independently notifies when its main run and reported subagents have finished. Other sessions may still be running.
- Watch and Unwatch only control monitoring and notifications. Quitting the tray or restarting the monitoring backend leaves native terminals running.
- Explicit Unwatch persists across later native turns and reconnects. Explicit selection/remote input or the desktop opening's 24-hour defaults can enable Watch again.
- Closing the native terminal disconnects its connector. A disconnect is not completion and never silently removes Watch.
- Prompts with uncertain delivery are not automatically replayed. A busy session rejects a second remote prompt.
- Supported structured requests also appear on phone/G2. No request is approved automatically; native terminal controls remain available.
- Pi and Codex use their runtime interruption APIs. On Windows, Claude Stop sends one Escape to the exact native console opened by its connector, matching Claude Code's default interrupt key. It checks the process creation time, session instance, current run and fresh state before writing input. It never selects the foreground window, sends a process-kill signal, changes Watch or retries an uncertain stop. Reopen an existing Claude connector terminal once while idle to enable the new capability.

## Implementation and limits

Codex uses its official App Server over authenticated loopback WebSocket. The native Codex TUI connects to the same server; a local link observes public lifecycle events and selected-session changes and forwards explicit remote answers to pending requests. Native responses pass through unchanged; the first answer claims the request. It does not scrape terminal text or intercept reasoning. The server belongs to the native terminal wrapper, not the tray. The remote App Server interface is experimental; CLI changes may require connector updates. Previously tested with Codex 0.157.0; 0.159.1 passed isolated initialization and empty-thread start/read during this audit, without a real model prompt.

Claude's remote connector remains experimental in 1.1.11. It uses per-launch lifecycle hooks plus an MCP channel, alongside the separate ordinary-terminal observer above. Connector configuration is local to that launch; duplicate global monitor events are skipped for connector-owned terminals. Its native transcript is read for visible messages and history only. The development-channel confirmation is required because this is a local custom channel. Previously tested with Claude Code 2.1.276: live hook and G2-channel delivery passed, but a successful model response was not verified. Ordinary-terminal hook payloads were also checked against installed Claude Code 2.1.287. Isolated connector tests pass; real Claude response and cancellation remain unverified.

Ordinary Windows Claude hooks run synchronously with a hidden encoded PowerShell launcher for literal path handling and UTF-8 stdin. A synthetic installed-hook fixture measured about 0.55 seconds per hook, including about 0.1 seconds for the native read-only owner probe. Tool-heavy turns can incur noticeable overhead; this is a fixture measurement, not a real-model latency guarantee. Linux uses direct Node hooks. The observer caches Windows liveness probes rather than launching one for every event.

Claude remote Stop uses the bundled, short-lived `Terminal-plus.TerminalInterrupt.exe`; no additional service or model key is required. MCP Channel itself has no interrupt method. The Agent SDK's `interrupt()` controls an SDK-owned execution connection; adopting it would change how the original interactive terminal is run, so this connector retains the native TUI. Escape can close a dialog or deselect a footer item instead of interrupting, and queued native messages may proceed afterward. Delivery acknowledgement therefore means **Stop requested**, not **Stopped**. The monitor confirms interruption from a new native transcript marker in the same run; it never invents completion from a key write or timeout, and outstanding subagents remain counted. Repeated requests in that run are refused to prevent a double-Escape rewind. If cancellation remains unconfirmed, check the native terminal.

On Linux, the connector uses a Python 3 PTY instead of the Windows helper. Native keyboard/output/resize pass through normally; a private, same-user control socket delivers the bound Escape after verifying process identity and the current snapshot. Closing the outer terminal closes the PTY; stopping Terminal+ leaves it running. Isolated two-terminal tests verify delivery only to the selected PTY and rejection of stale/duplicate requests. Claude model response and cancellation still need acceptance against a logged-in real session.

The helper uses [Microsoft AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole) and [WriteConsoleInput](https://learn.microsoft.com/en-us/windows/console/writeconsoleinput), with [Claude's documented Escape behavior](https://code.claude.com/docs/en/interactive-mode#general-controls). [Stop hooks do not run for user interrupts](https://code.claude.com/docs/en/hooks#stop). Automated Windows fixtures verify targeted input, process survival, stale-run rejection, duplicate suppression, transcript acknowledgement and subsequent prompts; real Claude task cancellation on the user's terminal still needs a live check.

Subagent counts reflect lifecycle events supplied by each agent. Tools are not agents, and no connector guesses subagents by inspecting response text. Local snapshots exclude reasoning and raw tool output. Pending approvals intentionally include the operation's supplied preview so you can review what you authorize. Native histories and approval previews may contain private project data, so keep the desktop connection key private.

## Phone commands and choices

Type commands in the existing phone or desktop prompt field while the session is idle. These use native operations and do not start an ordinary model prompt. G2 voice is for conversation, not slash-command entry.

| Operation | Pi | Codex | Claude |
| --- | --- | --- | --- |
| `/compact` | Supported, including optional instructions | Supported without arguments | Use the native terminal |
| `/model` | Opens the shared model chooser; `/model provider/id` also works | Use the native terminal | Use the native terminal |
| Tool approval | Pi's custom terminal dialogs stay local | Command/file approval; allow once, deny or cancel when offered | Channel tool approval; allow once or deny |
| Structured choice questions | The model chooser uses the shared form | `item/tool/requestUserInput`, including multiple questions/free text | Connector-owned `AskUserQuestion`: single-selection questions/free text; multi-select stays native |

Ordinary Claude monitoring displays `AskUserQuestion` text and options as conversation history, but cannot answer them. The explicit Claude connector uses the [official PreToolUse updatedInput contract](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) for supported questions. It waits up to five minutes for a remote answer; phone **Cancel**, timeout, channel disconnect or a changed run returns control to the normal native question without submitting an answer. This waiting hook is configured only for the connector's own `AskUserQuestion`; ordinary monitoring hooks are unchanged. Isolated hook/channel/mailbox tests pass; a real logged-in Claude question and physical G2 selection still need acceptance.

On G2, a supported short single question uses a native option list. Swipe selects; tap chooses an option. **Other / enter answer** opens the existing input editor, and sending answers that question rather than starting a new prompt. Multi-question, oversized, secret or unsupported forms must be reviewed on the phone or native terminal. Tool approvals retain the full-detail review path.

Unknown slash commands are rejected explicitly instead of being forwarded as conversation. Menus such as `/login`, `/resume`, arbitrary extension interfaces and prompts inside a CLI-launched shell program are not mirrored. Ordinary numbered lists in an assistant response remain conversation: answer them with an ordinary prompt.

Phone displays pending questions above its prompt field with their supplied details, options and optional text entry. Nothing is pre-approved; choose and confirm. G2 displays a short single question: scroll to choose, single tap confirms, double tap returns to the conversation without answering. SDK gestures dispatch immediately. Select **New prompt** to reopen a hidden pending choice. Short nonsecret free-text answers use **Other / enter answer**. Long approvals, multiple questions and secret inputs require the phone; G2 does not approve from a truncated preview.

Replies require the control key and bind to both session/connector instance and a short-lived request ID. Replies remain possible while the agent waits. Answering in the native Codex terminal clears the remote card; remote answers suppress a second native reply for the same request. Session changes, disconnects and resolved events retire requests. Claude's protocol silently ignores already-resolved IDs; its next tool/run hook also removes the card, so a submitted verdict is not a guarantee that the tool ran. No reply is retried after an uncertain delivery. Watch and terminal lifetime are unaffected.

Refresh the desktop page and install the Terminal+ Hub package for the choice UI (Terminal+ 1.1.11 with Terminal+ 1.1.11). For existing Pi terminals, run `/reload` while idle. Reopen existing Codex/Claude connector terminals through Terminal+ while idle to load the new code; this update does not close them for you.

API: `POST /api/interaction/respond`, with `Authorization: Bearer <connection-key>` and JSON `{ "sessionKey": "<key>", "requestId": "<id from state.interactions>", "answers": { "<question-id>": "<option-id or free text>" } }`. Menu requests marked `cancelable` also accept `cancel: true` with empty answers. Only current offered option IDs are accepted for closed-choice questions. `POST /api/prompt` retains its existing shape for slash commands. `/api/state` and SSE carry `interactions` and `commandStatus`.

Sources: [Codex official App Server](https://learn.chatgpt.com/docs/app-server) and the installed CLI's generated JSON schemas; [Claude Channel permission relay](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts); installed Pi `ExtensionContext.compact`, `modelRegistry.getAvailable` and `ExtensionAPI.setModel` declarations. Structured transport/gesture tests run against isolated fixtures; no user task or live model generation is executed during these tests.

G2 shows the current session's count, tunnel, model and title. Codex/Claude count the running main agent plus reported active children; an ended main agent is excluded even when children keep the session busy. Pi's official `subagent` example reports outstanding delegated tasks (including queued tasks); a parallel batch of three shows **3** while the parent waits, and a serial chain shows **1**. These are task counts, not OS process counts. Unknown Pi extension schemas keep the `1+` fallback. Existing Pi terminals need an idle `/reload` after a monitor update. Completion notifications prefer the session name, then a short first-user-message label, then the project folder name.

Primary references: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude hooks](https://code.claude.com/docs/en/hooks), [Claude channels](https://code.claude.com/docs/en/channels), [channel reference](https://code.claude.com/docs/en/channels-reference).
