# Even-Pilot

Watch your Pi, Codex and Claude Code sessions from your phone and Even G2. Keep using the original terminal for full output. Connect multiple Windows/Linux computers, manage Watch, and optionally receive Glance completion notifications through each computer or one central sender.

**1.1.0** · Windows 10/11 x64 · Linux x64/glibc · Even Hub/G2

[Downloads](https://github.com/Liang-Chu/Even-Pilot/releases) · [中文步骤](README.zh-CN.md) · [Release notes](RELEASE_NOTES.md)

## 1. Install a computer companion

Your computer and CLI must use the same system user. Keep your existing Pi/Codex/Claude installation and model login; Even-Pilot does not need those model keys.

**Windows**

1. Download `Even-Pilot-1.1.0-Setup-x64.exe` and run it. Click **Install**; Node and runtime dependencies are included.
2. The session management page opens. Later use the desktop shortcut or double-click the tray icon.
3. To start at login, right-click the tray and enable **Start with Windows**. Quit only closes the tray; Unwatch and monitoring shutdown leave native terminals running.

**Linux / SSH**

1. Download `Even-Pilot-1.1.0-Setup-linux-x64.run` and install as your normal user:

   ```sh
   sh ./Even-Pilot-1.1.0-Setup-linux-x64.run
   ```

2. Open a new supported shell, then run:

   ```sh
   even-pilot
   even-pilot pair
   ```

   Without a graphical desktop, the command prints the management address. `pair` prints the phone URL, connection key and Glance QR. Until you reopen the shell, use `~/.local/bin/even-pilot` or the installer's printed PATH command.
3. Use `even-pilot status`, `sessions`, `watch KEY`, `unwatch KEY` and `settings`. To keep a headless server running after SSH logout/reboot, use `even-pilot autostart on` and enable user lingering as described in [Linux setup](docs/linux.md). Headless session launches need `tmux`; the experimental Claude connector also needs `python3`.

Linux is tested on headless Ubuntu 26.04 LTS x86_64. Alpine/musl and untested ARM64 binaries are outside this release. Windows binaries are unsigned. The ZIP/TAR archives are optional portable alternatives.

## 2. Connect existing CLI sessions

| CLI | First connection | Supported behavior |
| --- | --- | --- |
| Pi | Even-Pilot installs the monitor extension. For an already open Pi, wait until idle and run `/reload` once. New Pi terminals load it automatically. | Live status, completion notifications and phone/G2 prompts. |
| Ordinary Codex CLI / Codex Desktop local session | No extra plugin or reopening required. Local sessions normally appear within seconds. | Observation and completion notifications. Remote reply/control requires a connector session. |
| Ordinary Claude Code | Installation adds official monitor hooks to this user's Claude settings. The next prompt establishes live monitoring; use `/hooks` to verify they loaded. | Read-only status and completion notifications, without a Channel or extra model key. Remote reply/control requires an experimental connector session. |

Select a session to open/reuse its original terminal. Use **+ New terminal** to create a connector-backed Codex/Claude session when remote input is required; Claude's connector asks for native development-channel confirmation. CLI login stays with its own tool; unsupported interactive menus still require the native terminal. If an existing Claude window has not picked up its new hooks, reopen it after its task finishes. Never reload a working task for this setup. [Connector limits](docs/connectors.md)

Opening management defaults Watch to sessions updated within 24 hours. Watch does not open a window; selecting does. Explicit Unwatch survives later native tasks and reconnects, and never kills a session. Selecting a session or opening desktop management can enable Watch again. Network loss keeps Watch, and completed tasks are reported per session rather than waiting for all computers to become idle. Known custom Claude Stop hooks can continue a turn, so completion stays unconfirmed when such hooks are present. Installation preserves unrelated Claude settings; uninstall removes only Even-Pilot's recorded hooks.

**Optional Pi multi-agent support:** base monitoring needs no subagent extension. If the official Pi subagent example is already installed and loaded, reuse it. Otherwise run `even-pilot enable-pi-subagents` on Linux, or the included `scripts/enable-pi-subagents.ps1` on Windows, then `/reload` in an idle Pi. It uses the matching official example and your existing model credentials. Other extensions may show `1+` when an exact count is unavailable. [Pi setup](docs/pi-extensions.md)

## 3. Connect your phone using Tailscale

1. Install [Tailscale](https://tailscale.com/download) on the computer and phone, sign into the same tailnet, and keep both connected.
2. Find the computer's `100.x.x.x` address. On Linux use `tailscale ip -4`.
3. On your phone, open `http://COMPUTER_IP:4317`. The Even-Pilot page should load. Keep the computer awake and allow TCP 4317 through its firewall if needed.

Use your own computer's address; `0.0.0.0` is a listening address. A reachable LAN also works. There is no need for a subnet router, exit node or public router port forwarding.

## 4. Connect Even Hub and G2

1. Install/upload `even-pilot-1.1.0.ehpk` in Even Hub. Use Even App 2.2.10 or newer and connect G2 to the phone.
2. On Windows open **Phone URL & key**; on Linux run `even-pilot pair`.
3. In the phone Hub app, open **Connection**, enter the **Bridge URL** and **Connection key**, and choose **Save computer**. Enter the plain key, without `Bearer`. Hub connection currently uses manual entry; the QR is for compatible companion apps such as Glance.
4. In **Sessions**, choose Watch for the sessions you need. Start Even-Pilot on G2; it returns to the last available watched session.

Connection details save automatically. To add another computer, use **Add computer** and its own URL/key. Sessions group by device and sort by newest update. G2 shows only watched sessions that are currently available; offline sessions stay watched and return when reachable.

## 5. Daily use

- **Phone:** choose a device/session, inspect folded tool records, manage Watch, or send a prompt to a supported session.
- **G2 list:** the top row is **+ New prompt**, followed by the latest ten messages. Both role arrows are on the left. Swipe to select and tap to expand full text; long messages split into text parts. Earlier history stays on the phone/computer.
- **G2 input:** tap to start/stop recording, hold to delete the last segment once per second. Double tap on an empty draft returns directly; otherwise choose **Send & exit** or **Exit only**. Voice is optional: save your own OpenAI/ElevenLabs key in **Voice** on the phone.
- **Exit:** double tap the session list for normal exit confirmation. **Terminate task** is in the menu; it requests interruption only for a supported connector. Linux's watcher CLI provides no prompt or interruption commands.
- **Glance:** optional per-session completion push, with suppression for the session currently displayed on G2. Scan the sender/center's QR, save and register in Glance. Follow the [Glance guide](https://github.com/Liang-Chu/Glance); configure direct/central routing in **Connection → Glance notifications** or Linux `settings`. [Routing guide](docs/notification-routing.md)

## Updates and known limitations

Each companion checks public GitHub releases once a day. Installation starts only when you choose Update. The desktop Updates dialog targets the computer serving that page; the phone Hub targets its active computer. Disable automatic checks in the tray/management **Updates**, or run `even-pilot update off`; use `even-pilot update on` to restore them. Installed Linux updates use `even-pilot update`, rather than `npm update`. Settings and native terminals are retained; old payloads stay for running connectors. Hub updates require uploading the matching new Hub package. GitHub pre-releases are excluded from checks. 1.1.0 uses the regular latest-release channel so existing clients can discover it. [Update details](docs/updates.md)

Physical G2 gestures, Bluetooth responsiveness, live voice and centralized Glance delivery still need acceptance on your devices. Claude remains experimental. [Audit evidence and limits](docs/release-status.md)

[Documentation](docs/README.md) · [API](docs/api.md) · [Development](docs/development.md) · [Publishing instructions](docs/publishing.md) · [Even Hub description](docs/even-hub-description.md)
