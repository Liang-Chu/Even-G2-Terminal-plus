# First-time setup and daily operation

This guide starts from a computer with a working Pi, Codex or Claude Code login. No previous Terminal+ configuration is assumed. For the shortest path, see the [quickstart](../README.md); [中文版](setup.zh-CN.md).

These instructions cover **Terminal+ 1.1.17**. See [release status](release-status.md) for verification and available downloads. Existing users should follow the [one-time migration](updates.md#migration-from-even-pilot).

## What you install

| Component | Where it runs | What it does |
| --- | --- | --- |
| Windows EXE or Linux companion (npm / `.run`) | Each computer whose sessions you want to watch | Reads local CLI events/history, keeps Watch settings and serves an API/manager on TCP 4317 |
| Even Hub `.ehpk` | Phone, through Even Hub | Connects to one or more companions and drives the G2 display/input |
| Original Pi/Codex/Claude CLI | Its original computer and user account | Runs the actual task and retains full output and its own model login |
| Glance, optional | Phone | Receives completion and input-needed notifications from a configured sender |

The companion is a watcher and lightweight session manager. Its browser portal and the phone Hub combine Pi, Codex and Claude sessions from explicitly saved computers. Each companion observes its own local CLI records. Installing it does not install the three CLIs or duplicate their model credentials. Voice and notification credentials are separate optional settings.

## Install a companion

### Windows

1. Download `Terminal-plus-1.1.17-Setup-x64.exe` from [Releases](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases).
2. Run it as the user who normally runs the CLI; choose **Install**. Node and runtime dependencies are embedded, so installation itself can work offline without system Node/npm or administrator access.
3. The browser manager opens. Use the desktop/start-menu shortcut or double-click the tray icon to reopen it. The default installation is `%LOCALAPPDATA%\Programs\Even-Pilot`; the installer may detect and upgrade an existing portable installation in its original directory.
4. Right-click the tray for background status, **Open Terminal+**, **Start with Windows**, update controls and **Quit Terminal+**. Quit exits the tray; it does not stop the detached monitoring backend or native CLI windows.

The ZIP is an optional portable alternative: extract the whole archive to a dedicated directory and run `Terminal-plus.exe`. Do not run only the EXE copied out of its companion files. Windows binaries are unsigned.

### Linux (headless or desktop)

The companion targets x64/glibc Linux. The tested baseline is headless Ubuntu 26.04 LTS; Alpine/musl is not supported by this package. Install as a normal user, without `sudo`.

**With Node 22+ and npm:**

```sh
npm install -g terminal-plus
terminal-plus-setup
```

If npm reports `EACCES`, use `npm install -g --prefix "$HOME/.local" terminal-plus`, then `~/.local/bin/terminal-plus-setup`. The helper works when npm disables install scripts, upgrades older installations and retains equal or newer versions.

**Installer / without npm:** download the Linux `.run` from Releases and execute the downloaded filename. Replace `VERSION` with its version:

```sh
sh ./Terminal-plus-VERSION-Setup-linux-x64.run
```

Both methods install the bundled runtime under `~/.local/lib/even-pilot`, create `~/.local/bin/terminal-plus` and add a removable PATH block for supported shells. The native companion is independent of the npm setup helper. First npm setup only deploys files; the `.run` starts monitoring by default. Open a **new shell**, then start monitoring and print connection details:

```sh
terminal-plus
terminal-plus pair
```

In the original shell, use `~/.local/bin/terminal-plus` or the PATH command printed by setup. On a desktop, the app entry opens the browser manager. On a headless server:

```sh
terminal-plus start
terminal-plus sessions
terminal-plus pair
```

`pair` prints the URL/key/Glance QR; it does not start the server itself. `terminal-plus` without arguments means `open`: it starts monitoring and applies the desktop's recent-24-hour Watch defaults, then opens a browser. On a headless host, `terminal-plus open` prints a private, already-authorized manager link for your browser; no manual desktop URL/key setup is needed. Keep that link private, like the `pair` output. Use `sessions` when you only want to inspect membership without resetting those defaults.

For reboot and SSH-logout persistence on a systemd machine:

```sh
terminal-plus autostart on
sudo loginctl enable-linger "$(id -un)"
```

Lingering is a user service policy and is not enabled by the installer. With no user systemd manager, the launcher uses a detached process; graphical login can use XDG autostart. A headless machine without systemd needs its own supervisor for reboot startup. [Linux details](linux.md)

Install `tmux` if you want Terminal+ to open native CLI sessions on a headless host. Claude's remote connector also needs `python3`; neither is installed by the companion. For Ubuntu/Debian, `sudo apt install tmux python3` installs these system tools.

## Connect existing CLI sessions

Use the same OS user and configuration directories for the companion and the CLI. A saved session appearing in the manager does not by itself prove that a live input connector is attached.

| CLI | What to do after companion installation | Remote capabilities |
| --- | --- | --- |
| Pi | Existing terminal: wait until idle, then `/reload`. New Pi terminals load the installed monitor extension automatically. | Monitor, send prompt, supported native commands and cancellation |
| Codex CLI / local Codex Desktop | No plugin or reopen. New sessions appear after their first saved prompt; local rollout files drive observation. | Ordinary sessions are read-only; prompt/control require a connector session |
| Claude Code | Official monitor hooks are added at installation/preparation. Its next prompt establishes observation. Check `/hooks`; if not loaded, reopen only after the current task finishes. | Ordinary sessions are read-only; remote prompt/control require the experimental Channel connector |

Claude transcripts larger than 32 MiB remain observable through bounded reads of the first 64 KiB and last 2 MiB, without scanning the whole history. The queue can discard definitely retired events whose first prompt cannot be recovered; uncertain/live events and missing history never imply completion. Full history remains in the native CLI.

For remote input to Codex/Claude, create a separate connector session using **+ New terminal**, choose **Tunnel** and an existing project path. On Linux you can also use:

```sh
terminal-plus new codex --cwd /your/project --name "My task"
terminal-plus new claude --cwd /your/project
```

Claude asks for **local development channel** confirmation in its native terminal. This does not bypass its approvals. Ordinary Claude monitoring does not require Channel access. Known custom Claude Stop hooks may continue work, so completion stays unconfirmed in that case. [Full capability table and limitations](connectors.md)

### Optional official Pi subagents

The basic monitor and multi-agent extension are different. Reuse an already loaded official subagent example. Otherwise:

- Windows installer: in **PowerShell**, with Pi 0.87.1+ installed, run the following. Replace the first line if you used a custom installation directory. Portable/source users can run `scripts/enable-pi-subagents.ps1` from their extracted/check-out directory.
- Linux: run `terminal-plus enable-pi-subagents`.

```powershell
$pilotRoot = Join-Path $env:LOCALAPPDATA 'Programs\Even-Pilot'
$pilotInstall = Get-Content -Raw (Join-Path $pilotRoot 'install.json') | ConvertFrom-Json
$pilotScript = Join-Path $pilotRoot ('versions\' + $pilotInstall.current + '\scripts\enable-pi-subagents.ps1')
powershell -NoProfile -ExecutionPolicy Bypass -File $pilotScript
```

Then wait for Pi to become idle and run `/reload`. The installer fetches the matching official example; child roles inherit the current model/login. Installing it makes the tool available, but the model chooses whether to delegate. See the [verification prompt and detailed steps](pi-extensions.md). Other third-party extensions may only report a lower bound such as `1+`.

To verify in Pi, ask it to use two `scout` subagents for a read-only project check. Confirm an actual `subagent` tool call and two task results in the terminal.

## Make the phone and computer reachable

1. Install [Tailscale](https://tailscale.com/download) on the phone/browser device and every companion computer. Join the same tailnet, or arrange access between them.
2. Find each computer's own Tailscale IPv4 address. On Linux use `tailscale ip -4`; on Windows use the Tailscale UI or that command if available.
3. In the viewing device's browser, test `http://COMPUTER_IP:4317` for each computer, replacing `COMPUTER_IP`. Each saved computer must be directly reachable from that device.
4. Keep the computer awake and allow inbound TCP 4317 through its host firewall on the intended private network. Terminal+ does not change the firewall automatically.

The addresses are user-specific and never baked into a package. `0.0.0.0` means listen on local interfaces; `127.0.0.1` on the phone means the phone. No subnet router, exit node or public router port-forwarding is needed. A directly reachable LAN works too. HTTP over Tailscale is supported.

Device labels use the local Tailscale name, such as `nuc`; if unavailable, the companion uses the OS hostname and shows a warning. Name lookup is separate from transport: a numeric Tailscale IP does not require MagicDNS.

## Connect Even Hub and multiple computers

1. Install **Terminal+ 1.1.17** (`terminal-plus-1.1.17.ehpk`) separately in Even Hub. Use **Terminal+ 1.1.17** companions and Even App 2.2.10+, then connect G2 to the phone.
2. Get a computer's values: Windows **Connect phone** in its local manager opens **Connect your phone** with this computer's URL/key and QR; Linux `terminal-plus pair` prints them.
3. In the phone Hub app open **Connection → Connect another computer** and enter:

   | Field | Value |
   | --- | --- |
   | Bridge URL | `http://COMPUTER_IP:4317`, with no `/api` path |
   | Connection key | That same computer's displayed plain key, without `Bearer` |

4. Choose **Connect computer**. The phone saves its first connection and loads that computer's shared list. Devices appear under **Connected computers**; use **View sessions** to select one, or **Edit connection** to correct its values.
5. Add any computer not already listed once from the phone or a paired browser, using its own URL/key. While open, viewers synchronize the list through reachable paired companions; other paired viewers learn the changes automatically. A new browser or phone needs only one known computer's URL/key.

Phone sessions are grouped by computer and ordered by latest update. A temporary disconnect keeps the connection and Watch membership; other computers still work. **Remove** synchronizes removal from the shared list, without stopping the computer's backend, Watch or terminals. Offline computers learn changes when an open viewer connects again; companions do not fetch lists from each other in the background. **Glance notifications** is a separate setup: pairing does not register a watcher or change notification delivery.

The shared list includes connection keys and is stored privately on paired companions. Only pair computers and viewers you trust to access all listed computers; there is no cloud account. Each viewer still reaches every session's source directly over Tailscale or LAN. The local Windows manager uses loopback for its own connection; the shared address is its reachable Tailscale/LAN URL, never another device's `127.0.0.1`.

Browser and phone connect each saved computer immediately at startup. Each computer gets up to five automatic retries per startup or manual reconnect cycle, each 30 seconds after failure. Successful connections do not reset used retries, and returning to the app's foreground does not reset the cycle or skip the wait. Once the budget is used, the computer stays **Offline** until a fresh app startup or its **Reconnect** under phone **Connection** / browser **Computers**. Manual Reconnect resets only that computer's budget. **Key rejected** (HTTP 401) does not retry; use **Edit connection** to correct its key. Watch is retained throughout.

## Browser portal from another device

1. On Windows, Linux or another device, open `http://SERVING_COMPUTER_IP:4317/?desktop=1` in a browser. Keep that computer's companion running.
2. Open **Computers → Connect another computer**. Enter one known computer's **Bridge URL** and **Connection key** from **Connect phone** or Linux `terminal-plus pair`, then choose **Connect computer**. Its shared list loads automatically. The local desktop shortcut connects its own computer automatically.
3. Add only computers that are not yet listed. **Sessions** shows Pi, Codex and Claude together, ordered by latest update, with watched/running counts. Choose **Status → All / Watched / Running**, use **Devices** to select one or several computers, and search to find a session. **All devices**, or clearing the last selected computer, shows every computer.
4. Choose **History** to read messages without starting a CLI or changing Watch. **Select** reuses a live session; **Open terminal** explicitly opens a saved session on its source computer. Pi supports its existing input controls; ordinary Codex/Claude sessions stay read-only, and connector capabilities still govern prompt/control/tools.

The browser caches its connection list and synchronizes it with reachable paired companions. Changing browser or portal address requires pairing one known computer once, then its shared list restores. Companions store the shared URLs/keys; they do not proxy session history or task traffic. Every target must remain directly reachable from the browser over Tailscale or LAN. Refresh/reconnect retains Watch; **Remove** removes the shared connection rather than stopping a task.

**Connect phone**, **Updates** and desktop **Glance notifications** apply to the computer serving the page. To change another computer's companion settings, open its own portal. Adding a viewer connection does not configure notification forwarding or Glance registration.

### Keys and the QR

| Value | Where it belongs |
| --- | --- |
| Connection key | Hub connection, authenticated manager/API, or Glance Credential; it grants control of that companion |
| Firebase service-account JSON | Only a computer sending FCM, or the central sender; never the Hub connection field |
| OpenAI/ElevenLabs transcription key | Optional phone **Voice** settings; not the CLI model key or connection key |
| Relay credential | Generated automatically when a source registers with a center; sources store this notification-only credential |

The displayed QR contains the computer URL and connection key. Glance understands it and derives `/api/glance`; scanning still requires **Save and register**. The Hub app currently uses manual URL/key entry. The QR/key can grant access to conversations and commands, so do not include it in public screenshots or release assets.

## Watch and native terminal operations

Browser and phone share compact **Status** and **Devices** dropdowns. Status selects **All**, **Watched** or **Running**; Devices can select several computers. Choose **All devices** or clear the last selection to show every computer. Watch only records membership; it does not open a window. **History** is a read-only preview and does not change Watch or start a CLI. **Select** reuses a live session; **Open terminal** explicitly opens a saved session on its source computer. Ordinary Codex/Claude sessions stay read-only; Pi and connector input capabilities remain unchanged.

- Opening from a computer's desktop shortcut or `terminal-plus open` applies Watch to that computer's sessions updated in the last 24 hours, without opening closed terminals.
- Browser refresh, backend restart and network reconnection do not reapply that opening rule.
- Explicit Unwatch survives subsequent native tasks/reconnects. Selecting the session, remote input or a later desktop opening can enable it again.
- Unwatch, tray Quit and monitoring shutdown never kill native terminals. Closing a native terminal disconnects its connector; it is not a successful completion.

For headless management, replace `SESSION` with the unique short KEY from `sessions`, or a quoted exact title:

```sh
terminal-plus sessions
terminal-plus sessions --watched
terminal-plus watch SESSION
terminal-plus unwatch SESSION
terminal-plus select SESSION
```

`select` opens/reuses and watches; `new` creates a native terminal. The Linux watcher CLI has no prompt-sending or interruption command. For CLI interaction attach to the tmux session:

```sh
tmux ls
tmux attach -t ACTUAL_SESSION_NAME
```

`Ctrl+B`, then `D`, detaches without stopping the CLI. [All headless commands](linux.md)

## Phone and G2 controls

Phone **Sessions** finds/manages sessions; **Conversation** shows messages, folded tool records and input; **G2** shows the display preview/diagnostics. Prompt and approval controls are available only for supported connectors. Unsupported slash commands and CLI menus stay in the native terminal. [Commands/choices](connectors.md#phone-commands-and-choices)

| G2 page | Action |
| --- | --- |
| Conversation list | Swipe selects; tap a message expands it; tap **New prompt** requests input; double tap opens normal exit confirmation |
| Expanded message | Native scrolling reads the full text; double tap returns to the list; menu **Next part / Previous part** handles oversized text |
| Input | Tap starts/stops recording; hold deletes the latest segment immediately and once per second while held |
| Empty input | Double tap returns without sending |
| Nonempty/recorded/pending input | Double tap opens **Send & exit** (default) / **Exit only**; tap confirms; double tap on confirmation returns to editing |
| Conversation menu | **Terminate task** requests supported cancellation; **Sessions** switches among reachable watched sessions |
| Supported question | Swipe through native options; tap to choose; **Other / enter answer** opens the input editor |

The list begins with **New prompt**, even when the session is read-only; in that case input tells you to continue in the original terminal. While working, a native active-agent row appears directly underneath. Tap it to open a snapshot of the main requested task and reported sub-agent tasks/tools; connectors without those details show them as unavailable. Double tap returns to the list. The latest ten messages follow; earlier history stays on phone/computer. Counts and message updates defer during browsing to preserve native focus. The header shows source computer, selected-session count, tunnel, model and title.

Voice is optional: open phone **Voice**, select OpenAI or ElevenLabs, enter your own transcription key and save. New or model-less OpenAI settings default to **GPT Transcribe** with streamed text; existing explicit Whisper choices, provider and keys are retained. Settings persist on that device. The phone sends audio directly to the chosen transcription provider, then sends the finished prompt to the target companion. [Voice models, privacy and gestures](voice.md)

For the selected session, a verified input request shows **Needs input**. A remotely answerable request has **Answer →**, which opens its question/approval panel; native-only requests say **Answer in original terminal**. G2 supports a short single question/options; oversized or multiple supported forms use the phone. Ordinary Claude questions can be read in history; answering requires an explicit connector session. Supported connector questions wait up to five minutes for the remote reply, and phone **Cancel** returns them to the native terminal immediately. Unsupported or multi-select forms stay native. [Question capabilities](connectors.md#phone-commands-and-choices)

## Optional Glance notifications

Monitoring works before push is configured. A new companion does not ship Firebase credentials. Install compatible Glance and configure/import your own Firebase project on the phone using its [setup guide](https://github.com/Liang-Chu/Glance#readme), then choose a delivery arrangement:

| Mode | Firebase setup | Glance PUSH registration |
| --- | --- | --- |
| Independent | On every computer that sends | One watcher per sender, using each sender's URL/key |
| Central | Only on the center; other computers forward to it | One watcher on the center, using the center's URL/key |

Notifications are per watched session on completion or a verified input/approval request. A session displayed on G2 suppresses completion while its viewing lease is valid; **Needs input** alerts remain allowed. Previewing on a phone/desktop does not suppress. Disconnecting or waiting for background work does not imply completion or input. Both independent and central senders use existing Glance registrations—no re-registration for the new alert type. Alerts omit question, approval and tool contents. `PUSH` uses FCM; Android's 15-minute polling limit applies to `POLL`. [Detection and answer limits](connectors.md#input-needed-notifications)

### Configure the sender

Use a service-account JSON authorized to send for **the same Firebase project configured/imported in the phone's Glance app**. Keep it readable in a private, stable location. Its private key is not a connection key; Android `google-services.json` is client configuration, not a sender credential. Each user supplies their own project/credentials; no APK rebuild is needed. Follow the [Glance sending prerequisites](glance-push.md).

On a Linux sender/center:

```sh
terminal-plus settings push direct
terminal-plus settings firebase --credentials /private/glance-sender.json
terminal-plus settings
terminal-plus pair
```

Replace the credential path with your own authorized JSON. The command derives the target from its `project_id`, saves that project and a private path reference, and restarts only monitoring. This target must match the phone's Glance project. `settings firebase clear` removes that saved configuration, not the file. Explicit `GOOGLE_APPLICATION_CREDENTIALS` / `EVEN_PILOT_FCM_PROJECT_ID` environment variables take precedence; status warns if they are set. For cross-project service accounts or ADC, set `EVEN_PILOT_FCM_PROJECT_ID` to the phone's target in the monitoring process/service environment and authorize the sender there.

On Windows, add `firebaseProjectId` and `firebaseCredentialsPath` to the **existing** `<installation>\.local\bridge-config.json`, preserving its connection keys:

```json
{
  "firebaseProjectId": "YOUR_FIREBASE_PROJECT_ID",
  "firebaseCredentialsPath": "C:\\Private\\glance-sender.json"
}
```

Replace `YOUR_FIREBASE_PROJECT_ID` with the phone's imported/configured project ID and the path with your private service-account file. Merge these two fields into the existing file, preserving its connection keys. Quit the tray, stop only that monitoring backend using the [authenticated shutdown steps](development.md#更新已有安装), then reopen the shortcut. Tray Quit alone does not reload Firebase settings. [Windows sender details](glance-push.md#windows-setup)

### Register Glance on the sender/center

1. Display its QR: Windows **Connect phone**, or Linux `terminal-plus pair`.
2. In Glance, scan it or manually enter the complete `http://SENDER_IP:4317/api/glance` URL and that sender's connection key as **Credential**.
3. Choose **PUSH**, then **Save and register**. Do this for each independent sender, or only for the center.

Keep the sending computer running. A sender status of configured or an FCM acceptance is not proof that the phone displayed a notification; verify one real watched-session completion. Do not use an old sender's key with a new center's URL.

### Forward other computers to a center

After the center is configured and registered, choose a setup method. From the phone, save source and center in **Connection**, then open **Glance notifications**:

1. **Computer:** select the source that runs the task.
2. **Send notifications:** choose **Through a central computer**.
3. **Central computer:** select the center.
4. Choose **Save notification settings**; repeat for other sources. The center itself uses **Directly from this computer**. The shown **Glance watcher** URL follows the sender/center; register that URL and its key in Glance separately.

Or configure each source on its own desktop: open **Glance notifications**, choose **Through a central computer**, fill **Center URL** with `http://CENTER_IP:4317` and **Center connection key** with that center's plain key, then **Save notification settings**. These settings affect only this computer. Saving notification settings does not add the center to browser session viewing; its control key is used for registration and is not saved by this dialog. The backend keeps a dedicated relay credential. An already saved center URL is prefilled; leave the key empty when keeping the same center.

The same operation over SSH, on each Linux source:

```sh
terminal-plus settings push forward --url http://CENTER_IP:4317 --key-file /private/center-key.txt
terminal-plus settings
```

Replace `CENTER_IP`; `/private/center-key.txt` must contain only the center's plain connection key, created privately by the owner. The key is not a command-line argument. Registration obtains a dedicated relay credential, so the source does not need Firebase or the center's full control key in its saved routing configuration.

To return a source to independent delivery use `terminal-plus settings push direct`, or choose **Directly from this computer** and save in the GUI. That computer now needs its own sender credentials and Glance watcher. Opening the dialog only reads settings; changes apply when explicitly saved. Forwarding is computer-to-computer and works without keeping Hub open; relay chains/self-forwarding are not supported. [Retry, expiry and route details](notification-routing.md)

## Update and remove

Installed companions automatically check for stable releases and install verified updates by default; existing opt-outs remain off. Clear **Automatic updates** in that computer's desktop manager/tray or use Linux `terminal-plus update off`; `on` enables them again. To install immediately, use its own **Updates**, the Windows tray's **Check for updates → Update to …**, or Linux `terminal-plus update`, then `terminal-plus update status`. Manual **Check now** only checks. Monitoring briefly restarts during installation; native terminals remain running. Phone Hub has no companion update controls.

Update companions for input-needed notifications and install **Hub 1.1.17** for its **Answer →** shortcut and updated G2 request UI. Existing Pi terminals need `/reload` only after their current task is idle. Reopen connector-backed Codex/Claude terminals while idle to load embedded connector changes; do not stop tasks for an update. Ordinary observer coverage is more limited than connector support. [Detection limits](connectors.md#input-needed-notifications)

Shared connections remain available: open the updated viewer that already has your computer list to publish verified records to reachable companions. Unverified offline records stay local until their identity can be checked; synchronized removals keep no key and prevent old caches from restoring removed computers. New browsers/phones pair one known computer to obtain the list. Older clients remain compatible but keep local-only lists.

**Companion updates do not install the phone/G2 app.** Install the `.ehpk` separately in Even Hub. Moving from `local.evenpilot.app` to `local.terminalplus.app` may require a new Hub listing/install; phone connections and voice keys may not transfer. Re-enter one known computer's URL/key and your transcription key if needed. Voice keys remain viewer-specific; shared computer connections do not copy voice, Firebase or model credentials. Companion Watch and Glance subscriptions remain in their existing data directory. Reopen connector-backed terminals after their task finishes to load new connector code; existing Pi can `/reload` while idle. [Update details](updates.md)

Windows uninstall is in **Settings → Apps → Terminal+**. Linux uses `terminal-plus uninstall`. Close connected terminals yourself first; uninstall protects running connections and preserves runtime data. To stop only monitoring on Linux use `terminal-plus stop`; native terminals keep working.

For an npm installation, run `npm uninstall -g terminal-plus` after the native uninstall to remove the setup helper. Saved settings remain.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Phone browser cannot reach the URL | Both Tailscale devices online, correct computer IP, companion running, computer awake, TCP 4317 allowed |
| Browser works but Hub cannot fetch | Install the current Hub package, use plain HTTP(S) origin/no API path, check the Even App network permission; keep the precise error/origin for diagnosis |
| Offline after retries | Restore the network/companion, then use that computer's **Reconnect** under phone **Connection** / browser **Computers**. Each cycle allows five automatic retries, 30 seconds after failure |
| Key rejected | Retries stop on HTTP 401. Use **Edit connection** with the current installation's **Connect phone** / `pair` key. Another installation directory can have a different key; normal in-place updates retain it |
| Tailscale reports DNS unavailable | Test the numeric Tailscale IP; MagicDNS is not needed for that connection |
| G2 shows reconnecting but phone is online | Check Even App's G2/Bluetooth connection and the G2 page's display status; backend connection and display connection are separate |
| New CLI missing | Same user/config directory; first saved prompt; Pi idle `/reload`; Claude `/hooks`; **Status → All**, **Devices → All devices**, then Watch |
| Codex/Claude says use original terminal | It is read-only observation; use a connector session if remote input is required |
| Linux command not found | Reopen a supported shell or use `~/.local/bin/terminal-plus`; check the installer PATH message |
| Linux cannot open a CLI | Install/login to that CLI, ensure `tmux` for headless launch, then restart the companion from the shell that can find it |
| No Glance completion push | Watch enabled, sender/center running, valid sender credentials, watcher saved/registered as PUSH on the correct sender, session not being displayed on G2 |
| Update succeeded but G2 UI unchanged | Install the Terminal+ `.ehpk` separately; desktop updates cannot replace it |

Linux logs: `journalctl --user -u even-pilot.service`. Windows startup diagnostics: `<installation>\.local\desktop-startup.log`. Do not clear runtime data to fix a routine reconnect: it contains keys, host identity, Watch and subscriptions. For a new operator/agent, use the [runbook](agent-runbook.md).
