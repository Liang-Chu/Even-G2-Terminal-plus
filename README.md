# Even-Pilot

A lightweight watcher for Pi, Codex and Claude Code on Windows/Linux. Keep working in your native CLI; see watched sessions on your phone and Even G2. The phone/G2 can send prompts only to input-capable sessions. Glance completion notifications are optional.

**1.1.4** · Windows 10/11 x64 · Linux x64/glibc · Even App 2.2.10+

[Download](https://github.com/Liang-Chu/Even-Pilot/releases) · [中文](README.zh-CN.md) · [Release notes](RELEASE_NOTES.md)

## Quick start

### 1. Install on each computer you want to watch

Keep your existing CLI installation and model login. Run Even-Pilot as the same operating-system user as that CLI.

- **Windows:** run `Even-Pilot-1.1.4-Setup-x64.exe` and choose **Install**. The manager opens; later use the desktop shortcut or double-click the tray. Right-click the tray to enable **Start with Windows**.
- **Linux / SSH:** download the Linux installer, then run as your normal user:

  ```sh
  sh ./Even-Pilot-1.1.4-Setup-linux-x64.run
  ```

  Open a new shell, then run `even-pilot status` and `even-pilot pair`. Until then, use `~/.local/bin/even-pilot`. The offline installer includes Node and backend dependencies; no global npm install is needed. [Headless service and reboot setup](docs/setup.md#linux-headless-or-desktop)

### 2. Attach an existing CLI

| Session started normally | First-time setup | Phone/G2 input |
| --- | --- | --- |
| Pi | The monitor extension is installed automatically. In an already open Pi, wait until idle and run `/reload` once. New Pi terminals load it automatically. | Supported |
| Codex CLI / local Codex Desktop | No plugin or reopening needed. Send a first prompt if the session has not saved any history yet. | Read-only; create a connector session for remote input |
| Claude Code | Installation adds official monitor hooks. Its next prompt begins observation; check `/hooks`, and reopen while idle if the hooks were not loaded. | Read-only; remote input needs the experimental connector |

To create a connector session, use **+ New terminal** in the manager and choose **Tunnel** and project directory. Claude asks for native Channel confirmation. Complete output and unsupported CLI menus stay in the original terminal. [Exact capabilities and limits](docs/connectors.md)

### 3. Make the computer reachable

1. Install [Tailscale](https://tailscale.com/download) on computer and phone; join the same tailnet and keep both connected.
2. Find **that computer's** `100.x.x.x` address (`tailscale ip -4` on Linux).
3. On the phone, open `http://COMPUTER_IP:4317`; the page should load. Replace `COMPUTER_IP` with your address. A reachable LAN also works.

No subnet router or exit node is needed. `127.0.0.1` reaches the device you are on; `0.0.0.0` is a listening address. Neither is your phone's computer address. [Connection troubleshooting](docs/setup.md#troubleshooting)

### 4. Install the phone app and save the connection

1. Install/upload `even-pilot-1.1.4.ehpk` in Even Hub; connect G2 in Even App.
2. On Windows open **Connect phone** to see this computer's phone URL/key. On Linux run `even-pilot pair`.
3. In the phone Hub app, open **Connection → Connect another computer**. Paste the computer's **Bridge URL** and **Connection key**, then **Connect computer**. Enter the plain key without `Bearer`.
4. The connection saves on this phone. Add each additional machine the same way with its own URL/key. On desktop use **Other computers** to combine remote sessions with local ones.

The displayed QR is for compatible apps such as Glance; Hub currently uses manual URL/key entry. Connecting a computer does not configure Glance notifications. [Multi-computer setup and key roles](docs/setup.md#connect-even-hub-and-multiple-computers)

### 5. Choose Watch, then open G2

Find the session in **Sessions** and enable **Watch**. If it is missing on desktop, check **All sessions**. G2 starts with the last available watched session and lists only watched, reachable sessions.

- **Watch** monitors without opening a terminal. **Unwatch** never stops a terminal or task.
- Selecting a saved session can open its terminal. An explicit desktop opening defaults Watch to sessions updated within 24 hours; ordinary refresh/reconnect does not reset Watch.
- Manual Unwatch persists through later tasks and network loss. Explicit selection or remote input can enable Watch again.
- Quitting the Windows tray or stopping the monitoring backend leaves native terminals running. Monitoring that is stopped cannot observe every completion.

## Everyday controls

G2 uses a native list: **New prompt**, the selected session's active-agent row while working, then the latest ten messages. Swipe to select; tap a message to expand native long text; double tap returns. In the list, double tap requests normal app exit. **Terminate task** is in the menu and requires an input-capable connector. [G2/input controls](docs/setup.md#phone-and-g2-controls)

Optional voice: save your own OpenAI/ElevenLabs transcription key in the phone's **Voice** settings. Tap starts/stops recording; hold deletes the last segment once per second. Double tap returns directly for an empty draft; otherwise choose **Send & exit** or **Exit only**. [Voice details](docs/voice.md)

Optional Pi multi-agent support: reuse an already loaded official subagent example, or run Linux `even-pilot enable-pi-subagents` / follow the [Windows script steps](docs/pi-extensions.md#第一步添加到-pi-的配置目录), then `/reload` while idle. This is separate from basic monitoring. [Installation and verification](docs/pi-extensions.md)

Optional Glance push: configure **each independent sender**, or configure **one center** and forward other computers to it. Only senders need Firebase credentials and Glance PUSH registration. [Step-by-step notification setup](docs/setup.md#optional-glance-notifications)

## Update

Windows tray: **Check for updates → Update to …**. Linux: `even-pilot update`; `even-pilot update off` disables automatic checks. The manager's **Updates** also works. Updates are requested explicitly; pairing/Watch persist and native terminals remain running.

**Companion updates do not update the phone Hub app.** Install the matching `.ehpk` separately in Even Hub. [Update details](docs/updates.md)

## Where to go next

- [Complete first-time setup](docs/setup.md) / [中文安装配置](docs/setup.zh-CN.md)
- [Runbook for a new operator or agent](docs/agent-runbook.md)
- [Documentation index](docs/README.md), [API](docs/api.md), [build/development](docs/development.md)
- [Audit evidence and known limits](docs/release-status.md), [publishing instructions](docs/publishing.md)

Linux binaries require x64/glibc; ARM64 and Alpine/musl are not covered by this release. Windows binaries are unsigned. Claude remains experimental, and physical G2/voice/push acceptance is distinct from automated tests.
