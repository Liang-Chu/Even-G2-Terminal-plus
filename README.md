# Terminal+

Watch Pi, Codex and Claude Code sessions running on Windows/Linux through Even Hub on your phone and Even G2. Continue working in your native terminal; each computer runs a lightweight companion and the phone combines their watched sessions.

See the source computer, model, reported running-agent count and recent messages. Optional features include sentence-by-sentence voice input, agent task details and completion notifications through Glance.

**Terminal+ 1.1.13** · Windows 10/11 x64 · Linux x64/glibc · Even App 2.2.10+

[Windows / Linux / Hub downloads](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases) · [Linux npm](https://www.npmjs.com/package/terminal-plus) · [中文](README.zh-CN.md) · [Full setup](docs/setup.md)

The Windows/Linux companion and phone/G2 app share the name **Terminal+**. Commands and filenames use `terminal-plus` / `Terminal-plus` where `+` is unsuitable. This guide targets **1.1.13**; see [release status](docs/release-status.md) for verification and publication.

## Quick start

### 1. Install the companion

Start with a working Pi, Codex or Claude Code installation. Install Terminal+ on each computer you want to watch, as the **same OS user who runs the CLI**. Your existing model login stays in use; Terminal+ does not install the CLIs.

- **Windows:** from [Releases](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases), download `Terminal-plus-1.1.13-Setup-x64.exe`, then choose **Install**. The manager opens. Later, use the **Terminal+** shortcut or double-click the tray icon. System Node/npm is not required.
- **Linux / SSH:** download `Terminal-plus-1.1.13-Setup-linux-x64.run`, then run as your normal user, without `sudo`:

  ```sh
  sh ./Terminal-plus-1.1.13-Setup-linux-x64.run
  ```

  Open a **new shell**, then run `terminal-plus` and `terminal-plus pair`. In the current shell, use `~/.local/bin/terminal-plus`. The installer includes its own Node runtime and backend dependencies.

  **npm alternative:** with Node 22+ and npm, run:

  ```sh
  npm install -g terminal-plus
  terminal-plus-setup
  ```

  Setup deploys the companion; start it and print the connection details in a **new shell**:

  ```sh
  terminal-plus
  terminal-plus pair
  ```

  This also works over SSH without a browser. Setup works when npm skips install scripts and retains an equal or newer installed version. If npm reports `EACCES`, use a user-owned installation:

  ```sh
  npm install -g --prefix "$HOME/.local" terminal-plus
  ~/.local/bin/terminal-plus-setup
  ```


For startup after login/reboot: Windows tray → **Start with Windows**; Linux → [headless service setup](docs/setup.md#linux-headless-or-desktop).

### 2. Attach your CLI

| CLI | First-time setup | Phone/G2 input |
| --- | --- | --- |
| Pi | The monitor extension installs automatically. In an already open terminal, wait until idle, then run `/reload` once. | Supported |
| Codex CLI / local Codex Desktop | Automatic observation; a new session appears after its first saved prompt. | Ordinary sessions are read-only |
| Claude Code (experimental) | The installer adds monitor hooks. Check `/hooks`; observation starts with the next prompt. Reopen while idle if hooks are missing. | Ordinary sessions are read-only |

Claude monitoring reads a bounded beginning and recent tail of large transcripts. The monitor can discard definitely retired events with no recoverable first prompt; missing history never marks a task as complete. Full history stays in the native CLI.

For Codex/Claude remote input, use **+ New terminal** in the manager to create a connector session. Choose **Tunnel** and the project directory; Claude also asks for Channel confirmation in its terminal. Headless Linux needs `tmux`; Claude's Linux connector also needs `python3`. [Linux prerequisites](docs/setup.md#linux-headless-or-desktop) · [Capabilities and limits](docs/connectors.md)

### 3. Connect the phone

1. For access over the internet, install [Tailscale](https://tailscale.com/download) on the phone and computers. Join the same tailnet and keep them connected. A reachable LAN also works.
2. Install **Terminal+ 1.1.13** (`terminal-plus-1.1.13.ehpk`) separately in Even Hub, then connect G2 in Even App. Use the **Terminal+ 1.1.13** Windows/Linux companion.
3. Get this computer's URL and key: Windows **Connect phone**; Linux `terminal-plus pair`.
4. In the phone app, open **Connection → Connect another computer**. Paste **Bridge URL** and **Connection key**, then choose **Connect computer**.

Use the reachable URL printed by **Connect phone** / `pair`, such as `http://COMPUTER_IP:4317`; `COMPUTER_IP` is the computer's Tailscale IP. Enter the key without `Bearer` and keep it private. The phone saves connections automatically; repeat for other computers. Keep the companion running and the computer awake. On Linux, `pair` prints information; `terminal-plus` starts monitoring.

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

In the phone's **Voice** settings, save your own **OpenAI API key** or **ElevenLabs key**. New or model-less OpenAI configurations default to **GPT Transcribe**, with streamed text. Existing provider, keys and explicitly saved Whisper choices are retained. A ChatGPT subscription alone does not provide API access. The phone needs internet access to the speech service.

In an input-capable session, open **New prompt**. Tap to record/stop each sentence; record again to add another. Hold deletes the latest segment, repeating once per second. Double tap returns for an empty draft; otherwise choose **Send & exit** or **Exit only**. [Voice setup and controls](docs/voice.md)

### Pi subagents

Already using the official Pi subagent extension? Keep it. Otherwise, run Linux `terminal-plus enable-pi-subagents` or follow the [Windows PowerShell steps](docs/setup.md#optional-official-pi-subagents), then `/reload` while Pi is idle. This optional tool is separate from the basic monitor. [Installation and verification](docs/pi-extensions.md)

### Glance completion notifications

Install [Glance](https://github.com/Liang-Chu/Glance) on Android for per-session completion push notifications. Choose one delivery mode:

| Mode | Firebase credentials | Glance PUSH registration |
| --- | --- | --- |
| Independent senders | On each sending computer | One watcher per sender |
| One central sender | On the center; other computers forward to it | One watcher for the center |

Configure **Glance notifications** on the companion, then register the sender/center in Glance using its QR or URL/key. Saving a computer in Hub does not register Glance. The session currently viewed on G2 does not send automatic completion notifications.

[Companion and forwarding setup](docs/setup.md#optional-glance-notifications)

## Updates

For the 1.1.13 Claude monitoring fixes, update the companion. Existing Terminal+ Hub installations continue to work; a phone/G2 update is optional for this fix.

**Upgrading from Even-Pilot:** manually run the new Terminal+ installer once. Older updaters may fail after the repository rename. Existing installation/data/service roots and `EVEN_PILOT_*` settings remain for compatibility; your connection key, Watch and notification settings are retained. [Migration and update guide](docs/updates.md#migration-from-even-pilot)

After that upgrade, companions automatically install verified stable updates by default. Disable **Automatic updates** on that computer, or use Linux `terminal-plus update off`; `on` restores it. To update now, use the Windows tray/manager or Linux `terminal-plus update`.

**Update the phone/G2 app separately** by installing its `.ehpk` in Even Hub. Moving from the older Hub app ID may require a fresh install; re-enter saved phone connections and voice keys if needed. Companion updates retain Watch and leave native terminals running. [Update guide](docs/updates.md)

An npm-installed companion uses the same automatic updater; `npm update` is not needed. To remove it, run `terminal-plus uninstall`, then `npm uninstall -g terminal-plus`. Saved settings remain. [Linux reference](docs/linux.md)

## More help

[Operator/agent runbook](docs/agent-runbook.md) · [Documentation](docs/README.md) · [Build/development](docs/development.md) · [Publishing](docs/publishing.md)

Claude support is experimental. Linux requires x64/glibc; ARM64 and Alpine/musl are not covered. Windows binaries are unsigned. [Audit evidence and known limits](docs/release-status.md)
