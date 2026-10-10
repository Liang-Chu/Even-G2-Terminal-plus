# Terminal+

Watch Pi, Codex and Claude Code sessions running on Windows/Linux from a browser, Even Hub on your phone, or Even G2. Continue working in your native terminal; each computer runs a lightweight companion and the viewer combines sessions from saved computers.

See the source computer, model, reported running-agent count and recent messages. Optional features include sentence-by-sentence voice input, agent task details, and completion or input-needed notifications through Glance.

**Terminal+ 1.1.18** · Windows 10/11 x64 · Linux x64/glibc · Even App 2.2.10+

[Windows / Linux / Hub downloads](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases) · [Linux npm](https://www.npmjs.com/package/terminal-plus) · [中文](README.zh-CN.md) · [Full setup](docs/setup.md)

The Windows/Linux companion and phone/G2 app share the name **Terminal+**. Commands and filenames use `terminal-plus` / `Terminal-plus` where `+` is unsuitable. This guide covers **1.1.18**; see [release status](docs/release-status.md) for verification and available downloads.

## Quick start

### 1. Install the companion

Start with a working Pi, Codex or Claude Code installation. Install Terminal+ on each computer you want to watch, as the **same OS user who runs the CLI**. Your existing model login stays in use; Terminal+ does not install the CLIs.

- **Windows:** from [Releases](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases), download `Terminal-plus-1.1.18-Setup-x64.exe`, then choose **Install**. The manager opens. Later, use the **Terminal+** shortcut or double-click the tray icon. System Node/npm is not required.
- **Linux / SSH:** download `Terminal-plus-1.1.18-Setup-linux-x64.run`, then run as your normal user, without `sudo`:

  ```sh
  sh ./Terminal-plus-1.1.18-Setup-linux-x64.run
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
2. Install **Terminal+ 1.1.18** (`terminal-plus-1.1.18.ehpk`) separately in Even Hub, then connect G2 in Even App. Use the **Terminal+ 1.1.18** Windows/Linux companion.
3. Get this computer's URL and key: Windows **Connect phone**; Linux `terminal-plus pair`.
4. In the phone app, open **Connection → Connect another computer**. Paste **Bridge URL** and **Connection key**, then choose **Connect computer**.

Use the reachable URL printed by **Connect phone** / `pair`, such as `http://COMPUTER_IP:4317`; `COMPUTER_IP` is the computer's Tailscale IP. Enter the key without `Bearer` and keep it private. Add other computers once from any connected viewer. The shared computer list then appears on your other paired browsers and phone; a new viewer needs only one known computer's URL/key to join. Keep the companions running and computers awake. On Linux, `pair` prints information; `terminal-plus` starts monitoring.

Hub uses manual URL/key entry; the QR is for Glance. If connection fails, first open the Bridge URL in the phone browser. [Troubleshooting](docs/setup.md#troubleshooting)

### Browser portal on another device

1. Open `http://COMPUTER_IP:4317/?desktop=1` in a browser, using a reachable computer running Terminal+.
2. Open **Computers → Connect another computer**. Enter one known computer's URL/key from **Connect phone** or `terminal-plus pair`. Its shared computer list loads automatically; add a new computer here only if it has not already been paired. The local desktop shortcut connects its own computer automatically.
3. In **Sessions**, choose **Status → All / Watched / Running** and use **Devices** to select one or several computers. **All devices**, or clearing the last selected computer, shows every computer.

While open, the phone/browser synchronizes the computer list with reachable paired companions, which store it privately, including connection keys. Pair only computers and viewers you trust to access every listed computer. Removing a computer synchronizes that removal without stopping its Watch or terminal. Offline computers receive changes when a viewer connects again. Sessions still load directly from their source: each browser/phone must reach those computers over Tailscale or LAN. **Connect phone**, **Updates** and desktop **Glance notifications** apply to the computer serving the page. [Portal details](docs/setup.md#browser-portal-from-another-device)

Browser and phone connect each saved computer immediately, then allow up to five automatic retries per startup or manual reconnect cycle, each 30 seconds after failure. Successes do not reset the retry budget; returning to the app does not reset it or skip the wait. After retries run out, the computer stays **Offline** until a fresh app startup or its **Reconnect** under **Computers** (browser) / **Connection** (phone). **Key rejected** stops retries; use **Edit connection** to correct the key. Watch is retained.

### 4. Choose sessions

In **Sessions**, enable **Watch**, then open Terminal+ on G2. G2 returns to the last available watched session and lists only watched, reachable sessions. If a session is missing, choose **Status → All** and **Devices → All devices**.

- **Watch** monitors without opening a terminal; **Unwatch** never stops a task or terminal.
- Opening a computer from its desktop shortcut or `terminal-plus open` defaults that computer's Watch to sessions updated within 24 hours. Refresh/reconnect does not reset Watch; manual Unwatch survives later tasks and network loss.
- **History** reads saved messages without starting a CLI or changing Watch. **Select** reuses a live session; **Open terminal** explicitly opens a saved session on its source computer. Pi retains its input support; ordinary Codex/Claude sessions remain read-only.
- Quitting the tray or stopping monitoring leaves native terminals running.

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

### Glance notifications

Install [Glance](https://github.com/Liang-Chu/Glance) on Android for per-session completion and **Needs input** push notifications. Choose one delivery mode:

| Mode | Firebase credentials | Glance PUSH registration |
| --- | --- | --- |
| Independent senders | On each sending computer | One watcher per sender |
| One central sender | On the center; other computers forward to it | One watcher for the center |

Configure **Glance notifications** on the companion, then register the sender/center in Glance using its QR or URL/key. Existing registrations work for both alert types; no re-registration is needed. Saving a computer in Hub does not register Glance. Viewing a session on G2 suppresses its completion alert, while a verified input/approval request can still notify. Alerts omit question, approval and tool contents; review them in the authenticated viewer or original terminal.

For the selected session's supported structured request, **Answer →** on the phone opens its question/approval panel. G2 supports a short single question through its existing options list and voice editor, including fields marked sensitive; users choose where to answer. Larger or multiple forms go to the phone. A detected native-only dialog still requires its original terminal. [Supported requests and limits](docs/connectors.md#input-needed-notifications)

[Companion and forwarding setup](docs/setup.md#optional-glance-notifications)

## Updates

Update the Windows/Linux companions and install **Hub 1.1.18** separately for shared computer connections. Open the updated phone app once if it already has your computer list; verified connections are published to reachable companions and become available to paired desktop browsers. Unverified offline entries stay in that viewer until they reconnect. A new browser/phone pairs one known computer to recover the shared list. Older clients can still connect, but do not synchronize their local lists.

**Upgrading from Even-Pilot:** manually run the new Terminal+ installer once. Older updaters may fail after the repository rename. Existing installation/data/service roots and `EVEN_PILOT_*` settings remain for compatibility; your connection key, Watch and notification settings are retained. [Migration and update guide](docs/updates.md#migration-from-even-pilot)

After that upgrade, companions automatically install verified stable updates by default. Disable **Automatic updates** on that computer, or use Linux `terminal-plus update off`; `on` restores it. To update now, use the Windows tray/manager or Linux `terminal-plus update`.

Windows 1.1.18 keeps desktop and Start menu shortcuts you have deleted from returning during updates, reinstalls or rollback. First installation still creates them.

**Update the phone/G2 app separately** by installing its `.ehpk` in Even Hub. Moving from the older Hub app ID may require a fresh install; re-enter saved phone connections and voice keys if needed. Companion updates retain Watch and leave native terminals running. [Update guide](docs/updates.md)

An npm-installed companion uses the same automatic updater; `npm update` is not needed. To remove it, run `terminal-plus uninstall`, then `npm uninstall -g terminal-plus`. Saved settings remain. [Linux reference](docs/linux.md)

## More help

[Operator/agent runbook](docs/agent-runbook.md) · [Documentation](docs/README.md) · [Build/development](docs/development.md) · [Publishing](docs/publishing.md)

Claude support is experimental. Linux requires x64/glibc; ARM64 and Alpine/musl are not covered. Windows binaries are unsigned. [Audit evidence and known limits](docs/release-status.md)
