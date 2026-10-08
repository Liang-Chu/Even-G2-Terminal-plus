# Even-Pilot

Watch Pi, Codex and Claude Code sessions running on Windows/Linux through Even Hub on your phone and Even G2. Continue working in your native terminal; each computer runs a lightweight companion and the phone combines their watched sessions.

See the source computer, model, reported running-agent count and recent messages. Optional features include sentence-by-sentence voice input, agent task details and completion notifications through Glance.

**Companion 1.1.8 · Terminal+ Hub 1.1.10** · Windows 10/11 x64 · Linux x64/glibc · Even App 2.2.10+

[Windows / Hub downloads](https://github.com/Liang-Chu/Even-Pilot/releases) · [Linux on npm](https://www.npmjs.com/package/even-pilot) · [中文](README.zh-CN.md) · [Full setup](docs/setup.md)

**Available now:** Linux npm **1.1.8**. GitHub currently has **1.1.7** Windows and Hub packages; Windows **1.1.8** and Terminal+ Hub **1.1.10** are prepared but awaiting upload. This guide describes that compatible pair. The phone app is named **Terminal+**; the computer companion remains **Even-Pilot**.

## Quick start

### 1. Install the companion

Start with a working Pi, Codex or Claude Code installation. Install Even-Pilot on each computer you want to watch, as the **same OS user who runs the CLI**. Your existing model login stays in use; Even-Pilot does not install the CLIs.

- **Windows:** from [Releases](https://github.com/Liang-Chu/Even-Pilot/releases), download the Windows `Setup-x64.exe`, then choose **Install**. The manager opens. Later, use the desktop shortcut or double-click the tray icon. System Node/npm is not required.
- **Linux / SSH with Node 22+ and npm:** run as your normal user, without `sudo`:

  ```sh
  npm install -g even-pilot
  even-pilot-setup
  ```

  Setup deploys the companion; start it and print the connection details in a **new shell**:

  ```sh
  even-pilot
  even-pilot pair
  ```

  This also works over SSH without a browser. Setup works when npm skips install scripts and retains an equal or newer installed version. If npm reports `EACCES`, use a user-owned installation:

  ```sh
  npm install -g --prefix "$HOME/.local" even-pilot
  ~/.local/bin/even-pilot-setup
  ```

  **Without npm:** download the Linux `Setup-linux-x64.run` from Releases, then run the downloaded file (replace `VERSION` with its version):

  ```sh
  sh ./Even-Pilot-VERSION-Setup-linux-x64.run
  ```

  Open a new shell, then run `even-pilot`. In the current shell, use `~/.local/bin/even-pilot`. Both installation methods include the companion's own Node runtime and backend dependencies.

For startup after login/reboot: Windows tray → **Start with Windows**; Linux → [headless service setup](docs/setup.md#linux-headless-or-desktop).

### 2. Attach your CLI

| CLI | First-time setup | Phone/G2 input |
| --- | --- | --- |
| Pi | The monitor extension installs automatically. In an already open terminal, wait until idle, then run `/reload` once. | Supported |
| Codex CLI / local Codex Desktop | Automatic observation; a new session appears after its first saved prompt. | Ordinary sessions are read-only |
| Claude Code (experimental) | The installer adds monitor hooks. Check `/hooks`; observation starts with the next prompt. Reopen while idle if hooks are missing. | Ordinary sessions are read-only |

For Codex/Claude remote input, use **+ New terminal** in the manager to create a connector session. Choose **Tunnel** and the project directory; Claude also asks for Channel confirmation in its terminal. Headless Linux needs `tmux`; Claude's Linux connector also needs `python3`. [Linux prerequisites](docs/setup.md#linux-headless-or-desktop) · [Capabilities and limits](docs/connectors.md)

### 3. Connect the phone

1. For access over the internet, install [Tailscale](https://tailscale.com/download) on the phone and computers. Join the same tailnet and keep them connected. A reachable LAN also works.
2. Install **Terminal+ 1.1.10** (`terminal-plus-1.1.10.ehpk`) separately in Even Hub, then connect G2 in Even App. It works with **Even-Pilot 1.1.8** companions; the two version numbers need not match.
3. Get this computer's URL and key: Windows **Connect phone**; Linux `even-pilot pair`.
4. In the phone app, open **Connection → Connect another computer**. Paste **Bridge URL** and **Connection key**, then choose **Connect computer**.

Use the reachable URL printed by **Connect phone** / `pair`, such as `http://COMPUTER_IP:4317`; `COMPUTER_IP` is the computer's Tailscale IP. Enter the key without `Bearer` and keep it private. The phone saves connections automatically; repeat for other computers. Keep the companion running and the computer awake. On Linux, `pair` prints information; `even-pilot` starts monitoring.

Each desktop manager shows only its own computer. Hub uses manual URL/key entry; the QR is for Glance. If connection fails, first open the Bridge URL in the phone browser. [Troubleshooting](docs/setup.md#troubleshooting)

### 4. Choose sessions

In **Sessions**, enable **Watch**, then open Terminal+ on G2. G2 returns to the last available watched session and lists only watched, reachable sessions. If a session is missing on desktop, check **All sessions**.

- **Watch** monitors without opening a terminal; **Unwatch** never stops a task or terminal.
- Opening the desktop manager defaults Watch to sessions updated within 24 hours. Refresh/reconnect does not reset Watch; manual Unwatch survives later tasks and network loss.
- Selecting a saved session can open its terminal. Quitting the tray or stopping monitoring leaves native terminals running.

[Session management](docs/setup.md#watch-and-native-terminal-operations)

To check the connection, run a short task in a watched CLI session. Its new messages and running/idle state should appear on the phone and G2. For a Glance completion test, close Terminal+ on G2 before running the task; the session being viewed there suppresses its own notification.

## G2 controls

Swipe to select; tap a message to expand it or the active-agent row to view available task details. G2 shows the latest ten messages. Double tap returns from expanded text; in the conversation list it requests normal app exit. **Terminate task** is in the menu and requires an input-capable session.

[Complete controls](docs/setup.md#phone-and-g2-controls)

## Optional features

### Voice input

In the phone's **Voice** settings, save your own **OpenAI API key** (Whisper/GPT Transcribe) or **ElevenLabs key**. A ChatGPT subscription alone does not provide API access. The phone needs internet access to the speech service.

In an input-capable session, open **New prompt**. Tap to record/stop each sentence; record again to add another. Hold deletes the latest segment, repeating once per second. Double tap returns for an empty draft; otherwise choose **Send & exit** or **Exit only**. [Voice setup and controls](docs/voice.md)

### Pi subagents

Already using the official Pi subagent extension? Keep it. Otherwise, run Linux `even-pilot enable-pi-subagents` or follow the [Windows PowerShell steps](docs/setup.md#optional-official-pi-subagents), then `/reload` while Pi is idle. This optional tool is separate from the basic monitor. [Installation and verification](docs/pi-extensions.md)

### Glance completion notifications

Install [Glance](https://github.com/Liang-Chu/Glance) on Android for per-session completion push notifications. Choose one delivery mode:

| Mode | Firebase credentials | Glance PUSH registration |
| --- | --- | --- |
| Independent senders | On each sending computer | One watcher per sender |
| One central sender | On the center; other computers forward to it | One watcher for the center |

Configure **Glance notifications** on the companion, then register the sender/center in Glance using its QR or URL/key. Saving a computer in Hub does not register Glance. The session currently viewed on G2 does not send automatic completion notifications.

[Companion and forwarding setup](docs/setup.md#optional-glance-notifications)

## Updates

Companions automatically install verified stable updates by default. Disable **Automatic updates** on that computer, or use Linux `even-pilot update off`; `on` restores it. To update now, use the Windows tray/manager or Linux `even-pilot update`.

**Update Terminal+ separately** by installing its `.ehpk` in Even Hub. Terminal+ 1.1.10 works with companion 1.1.8. Its new app ID may require a new Hub install; saved phone connections and voice keys may not transfer. Re-enter each computer's URL/key and your transcription key if needed. Companion updates retain Watch and leave native terminals running. [Update guide](docs/updates.md)

An npm-installed companion uses the same automatic updater; `npm update` is not needed. To remove it, run `even-pilot uninstall`, then `npm uninstall -g even-pilot`. Saved settings remain. [Linux reference](docs/linux.md)

## More help

[Operator/agent runbook](docs/agent-runbook.md) · [Documentation](docs/README.md) · [Build/development](docs/development.md) · [Publishing](docs/publishing.md)

Claude support is experimental. Linux requires x64/glibc; ARM64 and Alpine/musl are not covered. Windows binaries are unsigned. [Audit evidence and known limits](docs/release-status.md)
