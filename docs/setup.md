# First-time setup and daily operation

This guide starts from a computer with a working Pi, Codex or Claude Code login. No previous Even-Pilot configuration is assumed. For the shortest path, see the [quickstart](../README.md); [中文版](setup.zh-CN.md).

## What you install

| Component | Where it runs | What it does |
| --- | --- | --- |
| Windows EXE or Linux `.run` companion | Each computer whose sessions you want to watch | Reads local CLI events/history, keeps Watch settings and serves an API/manager on TCP 4317 |
| Even Hub `.ehpk` | Phone, through Even Hub | Connects to one or more companions and drives the G2 display/input |
| Original Pi/Codex/Claude CLI | Its original computer and user account | Runs the actual task and retains full output and its own model login |
| Glance, optional | Phone | Receives completion notifications from a configured sender |

The companion is a watcher and lightweight session manager. Installing it does not install the three CLIs or duplicate their model credentials. Voice and notification credentials are separate optional settings.

## Install a companion

### Windows

1. Download `Even-Pilot-1.1.4-Setup-x64.exe` from [Releases](https://github.com/Liang-Chu/Even-Pilot/releases).
2. Run it as the user who normally runs the CLI; choose **Install**. Node and runtime dependencies are embedded, so installation itself can work offline without system Node/npm or administrator access.
3. The browser manager opens. Use the desktop/start-menu shortcut or double-click the tray icon to reopen it. The default installation is `%LOCALAPPDATA%\Programs\Even-Pilot`; the installer may detect and upgrade an existing portable installation in its original directory.
4. Right-click the tray for background status, **Open Even-Pilot**, **Start with Windows**, update controls and **Quit Even-Pilot**. Quit exits the tray; it does not stop the detached monitoring backend or native CLI windows.

The ZIP is an optional portable alternative: extract the whole archive to a dedicated directory and run `Even-Pilot.exe`. Do not run only the EXE copied out of its companion files. Windows binaries are unsigned.

### Linux (headless or desktop)

The supplied binary targets x64/glibc Linux. The tested baseline is headless Ubuntu 26.04 LTS; Alpine/musl is not supported by this package. Install as a normal user, without `sudo`:

```sh
sh ./Even-Pilot-1.1.4-Setup-linux-x64.run
```

It installs its bundled runtime under `~/.local/lib/even-pilot`, creates `~/.local/bin/even-pilot`, starts monitoring and adds a removable PATH block for supported shells. Open a new shell before using the short command; in the current shell use the full path or the PATH command printed by the installer. This is a per-user global command, not an npm package installation.

```sh
even-pilot status
even-pilot pair
```

On a desktop, the app entry opens the browser manager. On a headless server:

```sh
even-pilot start
even-pilot sessions
even-pilot pair
```

`pair` prints the URL/key/Glance QR; it does not start the server itself. `even-pilot` without arguments means `open`: it starts monitoring and applies the desktop's recent-24-hour Watch defaults, then opens a browser or prints a management URL. Use `sessions` when you only want to inspect membership without resetting those defaults.

For reboot and SSH-logout persistence on a systemd machine:

```sh
even-pilot autostart on
sudo loginctl enable-linger "$(id -un)"
```

Lingering is a user service policy and is not enabled by the installer. With no user systemd manager, the launcher uses a detached process; graphical login can use XDG autostart. A headless machine without systemd needs its own supervisor for reboot startup. [Linux details](linux.md)

Install `tmux` if you want Even-Pilot to open native CLI sessions on a headless host. Claude's remote connector also needs `python3`; neither is installed by the companion. For Ubuntu/Debian, `sudo apt install tmux python3` installs these system tools.

## Connect existing CLI sessions

Use the same OS user and configuration directories for the companion and the CLI. A saved session appearing in the manager does not by itself prove that a live input connector is attached.

| CLI | What to do after companion installation | Remote capabilities |
| --- | --- | --- |
| Pi | Existing terminal: wait until idle, then `/reload`. New Pi terminals load the installed monitor extension automatically. | Monitor, send prompt, supported native commands and cancellation |
| Codex CLI / local Codex Desktop | No plugin or reopen. New sessions appear after their first saved prompt; local rollout files drive observation. | Ordinary sessions are read-only; prompt/control require a connector session |
| Claude Code | Official monitor hooks are added at installation/preparation. Its next prompt establishes observation. Check `/hooks`; if not loaded, reopen only after the current task finishes. | Ordinary sessions are read-only; remote prompt/control require the experimental Channel connector |

For remote input to Codex/Claude, create a separate connector session using **+ New terminal**, choose **Tunnel** and an existing project path. On Linux you can also use:

```sh
even-pilot new codex --cwd /your/project --name "My task"
even-pilot new claude --cwd /your/project
```

Claude asks for **local development channel** confirmation in its native terminal. This does not bypass its approvals. Ordinary Claude monitoring does not require Channel access. Known custom Claude Stop hooks may continue work, so completion stays unconfirmed in that case. [Full capability table and limitations](connectors.md)

### Optional official Pi subagents

The basic monitor and multi-agent extension are different. Reuse an already loaded official subagent example. Otherwise:

- Windows installer: follow the [script steps](pi-extensions.md#第一步添加到-pi-的配置目录), which resolve the active payload from `install.json`. The script is inside that payload. Portable/source users run `scripts/enable-pi-subagents.ps1` from their extracted/check-out directory.
- Linux: run `even-pilot enable-pi-subagents`.

Then wait for Pi to become idle and run `/reload`. The installer fetches the matching official example; child roles inherit the current model/login. Installing it makes the tool available, but the model chooses whether to delegate. See the [verification prompt and detailed steps](pi-extensions.md). Other third-party extensions may only report a lower bound such as `1+`.

## Make the phone and computer reachable

1. Install [Tailscale](https://tailscale.com/download) on the phone and every companion computer. Join the same tailnet, or arrange access between them.
2. Find each computer's own Tailscale IPv4 address. On Linux use `tailscale ip -4`; on Windows use the Tailscale UI or that command if available.
3. In the phone browser, test `http://COMPUTER_IP:4317`, replacing `COMPUTER_IP`. The page should load before you try the Hub app.
4. Keep the computer awake and allow inbound TCP 4317 through its host firewall on the intended private network. Even-Pilot does not change the firewall automatically.

The addresses are user-specific and never baked into a package. `0.0.0.0` means listen on local interfaces; `127.0.0.1` on the phone means the phone. No subnet router, exit node or public router port-forwarding is needed. A directly reachable LAN works too. HTTP over Tailscale is supported.

Device labels use the local Tailscale name, such as `nuc`; if unavailable, the companion uses the OS hostname and shows a warning. Name lookup is separate from transport: a numeric Tailscale IP does not require MagicDNS.

## Connect Even Hub and multiple computers

1. Install/upload `even-pilot-1.1.4.ehpk` in Even Hub. Use Even App 2.2.10+ and connect G2 to the phone.
2. Get a computer's values: Windows **Connect phone** in its local manager opens **Connect your phone** with this computer's URL/key and QR; Linux `even-pilot pair` prints them.
3. In the phone Hub app open **Connection → Connect another computer** and enter:

   | Field | Value |
   | --- | --- |
   | Bridge URL | `http://COMPUTER_IP:4317`, with no `/api` path |
   | Connection key | That same computer's displayed plain key, without `Bearer` |

4. Choose **Connect computer**. Connection details persist on this phone and restore next time. Saved devices appear under **Connected computers**; use **View sessions** to select one, or **Edit connection** to correct its saved values.
5. Add another machine through the same collapsed **Connect another computer** form, using its own URL/key. On desktop, **Other computers** adds remote machines alongside **This computer**, which connects automatically. Repeat additions in each viewer that should manage the fleet; saved computer lists belong to that phone/browser.

Sessions are grouped by computer and ordered by latest update. A temporary disconnect keeps the saved connection and Watch membership; other computers still work. Removing a remote computer only forgets it on this viewer, without stopping its backend or terminals. **Glance notifications** is a separate setup: saving a computer here does not register a watcher or change notification delivery.

### Keys and the QR

| Value | Where it belongs |
| --- | --- |
| Connection key | Hub connection, authenticated manager/API, or Glance Credential; it grants control of that companion |
| Firebase service-account JSON | Only a computer sending FCM, or the central sender; never the Hub connection field |
| OpenAI/ElevenLabs transcription key | Optional phone **Voice** settings; not the CLI model key or connection key |
| Relay credential | Generated automatically when a source registers with a center; sources store this notification-only credential |

The displayed QR contains the computer URL and connection key. Glance understands it and derives `/api/glance`; scanning still requires **Save and register**. The Hub app currently uses manual URL/key entry. The QR/key can grant access to conversations and commands, so do not include it in public screenshots or release assets.

## Watch and native terminal operations

Desktop **Watched / All sessions** and phone **All / Watched / Running** filters help locate sessions. Watch only records membership; it does not open a window. Selecting an available live session reuses its connection; selecting a saved session can open its native terminal. An already observed read-only session is not turned into a second writer.

- Each explicit desktop opening applies Watch to sessions updated in the last 24 hours, without opening closed terminals.
- Browser refresh, backend restart and network reconnection do not reapply that opening rule.
- Explicit Unwatch survives subsequent native tasks/reconnects. Selecting the session, remote input or a later desktop opening can enable it again.
- Unwatch, tray Quit and monitoring shutdown never kill native terminals. Closing a native terminal disconnects its connector; it is not a successful completion.

For headless management, replace `SESSION` with the unique short KEY from `sessions`, or a quoted exact title:

```sh
even-pilot sessions
even-pilot sessions --watched
even-pilot watch SESSION
even-pilot unwatch SESSION
even-pilot select SESSION
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

The list begins with **New prompt**, even when the session is read-only; in that case input tells you to continue in the original terminal. While working, a native active-agent row appears directly underneath. The latest ten messages follow; earlier history stays on phone/computer. Counts and message updates defer during browsing to preserve native focus. The header shows source computer, selected-session count, tunnel, model and title.

Voice is optional: open phone **Voice**, select OpenAI or ElevenLabs, enter your own transcription key and save. It persists on that device. The phone sends audio directly to the chosen transcription provider, then sends the finished prompt to the target companion. [Voice models, privacy and gestures](voice.md)

Ordinary Claude questions can be read in history; answering requires an explicit connector session. Supported connector questions wait up to five minutes for the remote reply, and phone **Cancel** returns them to the native terminal immediately. Supported multiple questions use the phone; unsupported or multi-select forms stay native. [Question capabilities](connectors.md#phone-commands-and-choices)

## Optional Glance notifications

Monitoring works before push is configured. A new companion does not ship Firebase credentials. Install a compatible [Glance](https://github.com/Liang-Chu/Glance) app on the phone and choose a delivery arrangement:

| Mode | Firebase setup | Glance PUSH registration |
| --- | --- | --- |
| Independent | On every computer that sends | One watcher per sender, using each sender's URL/key |
| Central | Only on the center; other computers forward to it | One watcher on the center, using the center's URL/key |

Completion is per watched session. A session displayed on G2 is suppressed while its viewing lease is valid; other sessions still notify. Previewing on a phone/desktop does not suppress. Disconnecting is not completion. `PUSH` uses FCM; Android's 15-minute polling limit applies to `POLL`, not this push route.

### Configure the sender

Use a service-account JSON authorized to send for the installed Glance Firebase project, currently `even-glance`. Keep it readable in a private, stable location. Its private key is not a connection key; an arbitrary Firebase project or Android `google-services.json` is not a sender credential. Follow the [Glance sending prerequisites](glance-push.md).

On a Linux sender/center:

```sh
even-pilot settings push direct
even-pilot settings firebase --credentials /private/glance-sender.json
even-pilot settings
even-pilot pair
```

Replace the credential path with your existing authorized JSON. The command saves a path reference and restarts only monitoring. `settings firebase clear` removes that reference, not the file. Explicit `GOOGLE_APPLICATION_CREDENTIALS` / `EVEN_PILOT_FCM_PROJECT_ID` environment variables take precedence; status warns if they are set.

On Windows, add `firebaseProjectId` and `firebaseCredentialsPath` to the **existing** `<installation>\.local\bridge-config.json`, preserving its connection keys:

```json
{
  "firebaseProjectId": "even-glance",
  "firebaseCredentialsPath": "C:\\Private\\glance-sender.json"
}
```

This is a two-field fragment to merge, not a replacement file. Quit the tray, stop only that monitoring backend using the [authenticated shutdown steps](development.md#更新已有安装), then reopen the shortcut. Tray Quit alone does not reload Firebase settings. [Windows sender details](glance-push.md#windows-setup)

### Register Glance on the sender/center

1. Display its QR: Windows **Connect phone**, or Linux `even-pilot pair`.
2. In Glance, scan it or manually enter the complete `http://SENDER_IP:4317/api/glance` URL and that sender's connection key as **Credential**.
3. Choose **PUSH**, then **Save and register**. Do this for each independent sender, or only for the center.

Keep the sending computer running. A sender status of configured or an FCM acceptance is not proof that the phone displayed a notification; verify one real watched-session completion. Do not use an old sender's key with a new center's URL.

### Forward other computers to a center

After the center is configured and registered, save both source and center on this viewer: phone **Connection** or desktop **Other computers**. Open the separate **Glance notifications** dialog:

1. **Computer:** select the source that runs the task.
2. **Send notifications:** choose **Through a central computer**.
3. **Central computer:** select the center.
4. Choose **Save notification settings**; repeat for other sources. The center itself uses **Directly from this computer**. The shown **Glance watcher** URL follows the sender/center; register that URL and its key in Glance separately.

The same operation over SSH, on each Linux source:

```sh
even-pilot settings push forward --url http://CENTER_IP:4317 --key-file /private/center-key.txt
even-pilot settings
```

Replace `CENTER_IP`; `/private/center-key.txt` must contain only the center's plain connection key, created privately by the owner. The key is not a command-line argument. Registration obtains a dedicated relay credential, so the source does not need Firebase or the center's full control key in its saved routing configuration.

To return a source to independent delivery use `even-pilot settings push direct`, or choose **Directly from this computer** and save in the GUI. That computer now needs its own sender credentials and Glance watcher. Opening the dialog only reads settings; changes apply when explicitly saved. Forwarding is computer-to-computer and works without keeping Hub open; relay chains/self-forwarding are not supported. [Retry, expiry and route details](notification-routing.md)

## Update and remove

Windows tray: **Check for updates → Update to …**. Linux: `even-pilot update`, then `even-pilot update status`. The manager's **Updates** targets its serving computer; phone Hub targets the computer active when the dialog opens. Automatic checks can be disabled in the tray/Updates or with `even-pilot update off`.

**Companion updates do not install the phone package.** Install the matching `even-pilot-1.1.4.ehpk` separately in Even Hub. Existing connections, Watch and subscriptions persist. Reopen connector-backed terminals after their task finishes to load new connector code; existing Pi can `/reload` while idle. [Update details](updates.md)

Windows uninstall is in **Settings → Apps → Even-Pilot**. Linux uses `even-pilot uninstall`. Close connected terminals yourself first; uninstall protects running connections and preserves runtime data. To stop only monitoring on Linux use `even-pilot stop`; native terminals keep working.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Phone browser cannot reach the URL | Both Tailscale devices online, correct computer IP, companion running, computer awake, TCP 4317 allowed |
| Browser works but Hub cannot fetch | Install the current Hub package, use plain HTTP(S) origin/no API path, check the Even App network permission; keep the precise error/origin for diagnosis |
| Connection key rejected | Copy the current running installation's **Connect phone** / `pair` key. A fresh installation in another directory can have a different key on the same computer; normal in-place updates retain it |
| Tailscale reports DNS unavailable | Test the numeric Tailscale IP; MagicDNS is not needed for that connection |
| G2 shows reconnecting but phone is online | Check Even App's G2/Bluetooth connection and the G2 page's display status; backend connection and display connection are separate |
| New CLI missing | Same user/config directory; first saved prompt; Pi idle `/reload`; Claude `/hooks`; desktop **All sessions**, then Watch |
| Codex/Claude says use original terminal | It is read-only observation; use a connector session if remote input is required |
| Linux command not found | Reopen a supported shell or use `~/.local/bin/even-pilot`; check the installer PATH message |
| Linux cannot open a CLI | Install/login to that CLI, ensure `tmux` for headless launch, then restart the companion from the shell that can find it |
| No Glance completion push | Watch enabled, sender/center running, valid sender credentials, watcher saved/registered as PUSH on the correct sender, session not being displayed on G2 |
| Update succeeded but G2 UI unchanged | Install the matching phone `.ehpk` separately; desktop updates cannot replace it |

Linux logs: `journalctl --user -u even-pilot.service`. Windows startup diagnostics: `<installation>\.local\desktop-startup.log`. Do not clear runtime data to fix a routine reconnect: it contains keys, host identity, Watch and subscriptions. For a new operator/agent, use the [runbook](agent-runbook.md).
