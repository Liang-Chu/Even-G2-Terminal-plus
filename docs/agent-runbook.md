# Operator and agent runbook

Start here when you have no history from the original setup. For a new user, follow [setup](setup.md) / [中文安装指南](setup.zh-CN.md). This file explains how to inspect, maintain and rebuild an existing installation without relying on remembered machine names or credentials.

## Establish the current installation

1. Identify the computer, operating-system user and actual installation root. Run as the same user as the native CLI. A custom or portable installation may not use the default directory.
2. Identify the task: monitor a local session, connect a viewer, configure notifications, update the companion, or install the phone package. These are separate operations.
3. On Linux run `even-pilot status`, `even-pilot sessions` and `even-pilot settings`. These show monitoring/session/sender state without printing keys. Use `even-pilot pair` only when the owner needs connection details.
4. On Windows open the shortcut and inspect Sessions and the tray's running state. The desktop manager controls only this computer. **Connect phone** opens **Connect your phone** with its URL/key; add each computer in phone **Connection** to combine sessions there.
5. Check the installed version and [release status](release-status.md). Do not infer a deployed version from the source checkout or a file left in Downloads.

The default backend listens on TCP 4317. Only one monitor should own a given data directory and port. Network loss, Unwatch and monitoring shutdown must not be turned into task completion or terminate native terminals.

## Find files without exposing secrets

| Item | Windows default | Linux default |
| --- | --- | --- |
| Application root | `%LOCALAPPDATA%\Programs\Even-Pilot` | `~/.local/lib/even-pilot` |
| User entry point | Installed shortcut → active payload's `Even-Pilot.exe`; portable may have a root launcher | `~/.local/bin/even-pilot` |
| Active payload | `versions/<version>-<build-id>/` | `current` symlink → `versions/<version>-<build-id>/` |
| Private runtime data | `.local/` at the installation root | `~/.local/share/even-pilot` |
| User service | Windows tray/login entry | `~/.config/systemd/user/even-pilot.service` |
| Backend diagnostics | `.local/desktop-startup.log` | `journalctl --user -u even-pilot.service` |

Linux respects `XDG_DATA_HOME` and `XDG_CONFIG_HOME`; `EVEN_PILOT_DATA_DIR` overrides the runtime data directory on both platforms. A portable/source install uses its own data root. Inspect shortcut/service launch arguments and `install.json` before assuming the defaults. Custom Linux services can also use `EVEN_PILOT_SERVICE_NAME`.

Private data includes:

- `bridge-config.json`: connection credentials and an optional Firebase credential-file reference.
- `monitoring.json`, `host-id`: Watch preferences and stable device identity.
- `native/`, `claude-events/`: local monitor snapshots/queues.
- `notifications.json`, `glance-push.json`, `notification-routing.json`: completion journal, Glance subscriptions/jobs and relay state.

Do not print, commit or copy these files into logs or release packages. Do not copy keys or model-login configuration to another computer by default. Updating an existing installation preserves its own identity and data; deleting the data directory is not a connection or push repair procedure.

Native CLI locations are independent: Pi uses `~/.pi/agent` or `PI_CODING_AGENT_DIR`; Codex uses `CODEX_HOME` (default `~/.codex`); Claude uses `CLAUDE_CONFIG_DIR` (default `~/.claude`). Only this user's local records are observed. WSL, containers, other users and cloud-only conversations need a companion in the environment where records actually exist.

## Common installed operations

Linux does not require a browser, system Node or npm:

```sh
even-pilot start
even-pilot status
even-pilot sessions --watched
even-pilot watch SESSION
even-pilot unwatch SESSION
even-pilot select SESSION
even-pilot settings
even-pilot update check
```

Replace `SESSION` with a unique short key from `sessions`, or a quoted exact title. `select` can open a terminal; `watch` and `unwatch` cannot. No-argument `even-pilot` is `open`: it starts the manager and applies the desktop opening's 24-hour default Watch rule. On a headless host it prints a private authenticated manager link to open in your browser, without manual desktop URL/key setup; keep it confidential like `pair`. `sessions` only lists; `pair` only displays connection information and does not start monitoring. [Linux commands and service setup](linux.md)

Windows tray Quit closes the tray only. To reload backend configuration manually, use the [authenticated monitoring shutdown procedure](development.md#更新已有安装), then reopen the shortcut. Never replace this with broad process killing. Installed upgrades perform their own backend shutdown and keep native terminal processes alive.

Installed companions automatically check and install stable verified updates by default; an existing disabled preference remains disabled. Use the local desktop/tray's **Automatic updates** toggle or Linux `even-pilot update on|off` to change that preference. `update check` only checks; `update` installs immediately. The phone Hub has no companion update controls, and its `.ehpk` is installed separately. [Update policy and recovery](updates.md)

For notifications, first decide **direct** versus **central**. A phone's saved connection is not the source's notification route. Desktop notification settings affect only that local source; phone settings select from its saved computers. Only the sender/center needs Firebase and a registered Glance PUSH watcher. A center URL/key supplied on desktop is used for relay registration, not for adding a remote session viewer; the backend retains a dedicated notification-only relay credential. Use [setup commands](setup.md#optional-glance-notifications) or [routing details](notification-routing.md); do not install a user's private Firebase JSON on every source.

## Source map

| Area | Entry points |
| --- | --- |
| Shared monitoring backend/API | `apps/windows/src/cli.ts`, `server.ts`, `config.ts` |
| Session discovery, Watch and terminal state | `packages/pi-runtime/native-host.ts`, `native-protocol.ts`, `packages/connectors/` |
| Pi integration | `apps/windows/src/pi-extension.ts`, `install-extension.ts`, `packages/pi-runtime/subagent-tracker.ts` |
| Read-only Codex/Claude observation | `packages/connectors/codex-observer.ts`, `claude-observer.ts`; `apps/windows/src/install-claude-monitor.ts` |
| Remote-input native terminals | `apps/windows/src/connectors/`; Linux terminal adapter `apps/linux/src/platform.ts` |
| Windows tray and installer | `apps/windows/desktop/Tray.cs`, `Installer.cs`, `build.ps1` |
| Linux entry point, service, settings | `apps/linux/bin/even-pilot`, `src/desktop.ts`, `session-cli.ts`, `settings-cli.ts`, `install.mjs` |
| Phone and multi-computer viewer | `apps/evenhub/src/main.ts`, `bridge/fleet.ts`, `sessions/` |
| G2 native UI/transport and voice | `apps/evenhub/src/g2/`, `voice/` |
| Notifications/FCM/relay | `apps/windows/src/notifications.ts`, `push.ts`, `fcm.ts`, `notification-relay.ts` |
| Verified companion updates | `apps/windows/src/updates.ts`, `update-worker.mjs`; `docs/updates.md` |
| Packaging and isolated regression tests | `scripts/package-release.mjs`, `package-linux.mjs`, `tests/` |

## Build and verify a source checkout

Use Node 22+ and the committed lockfile. Installed users should use the release installers instead of these commands.

```sh
npm ci
npm run check
npm audit
npm audit --omit=dev
```

`check` runs type checking, regression tests and the browser build. On Windows also run `npm run desktop:test` for the C# tray/installer tests. Existing validation records belong to the versions named in [release status](release-status.md); do not describe older tests as fresh verification.

`npm run dev` serves the development frontend on 5173. `npm start` starts the shared backend on 4317 and installs the Pi monitor extension; it is not a harmless read-only inspection command. Before starting a test backend, isolate `EVEN_PILOT_DATA_DIR`, the CLI configuration directories and port from real installations. Prefer the existing test fixtures rather than opening terminals or sending live model/push requests just to test a pipeline.

Windows release staging:

```powershell
npm run release:build
node tests/release-smoke.mjs "<generated-release-directory>"
node tests/installer-smoke.mjs "<generated-release-directory>"
```

Linux release staging, on a native Linux host:

```sh
npm ci --ignore-scripts
npm run check
npm run release:linux
node tests/linux-installer-smoke.mjs "<generated-Setup.run>"
node tests/linux-installer-smoke.mjs "<generated-Setup.run>" --systemd
```

Linux packaging needs the matching official Node archive in `outputs/toolchain`; the packaging script verifies official checksums and the build binary. Windows packaging downloads or uses verified cached runtime files. Both include production dependencies for offline installation. Smoke scripts use isolated directories; systemd and architecture acceptance require the corresponding host capabilities. [Build details](development.md)

`npm run pack:evenhub` builds the smaller Hub-only frontend and packs the `.ehpk`. It is a separate artifact from both companions. Source `apps/evenhub/dist` is the desktop/browser build; `dist-hub` excludes desktop-only modules. No npm package publication is configured (`private: true`).

## Deploy and hand over

1. Verify the generated installer/package and checksum against the intended version. Keep secrets and personal runtime data out of the release folder.
2. Update Windows by running its Setup EXE; update Linux as the owning user with `sh ./<new-Setup-linux-x64.run>`, or use the installed explicit update command. Do not overwrite an active immutable payload.
3. Confirm the installed version, backend running state, saved device identity and Watch. Old native terminals remain independent; reload Pi or reopen connector terminals only after their task finishes.
4. Install the matching `.ehpk` separately on the phone. Recheck saved connections before asking the owner to re-enter anything.
5. State what was tested, on which platform/version, and what still needs physical phone/G2 acceptance. Do not send a live notification, make a paid model request or publish externally unless that work is authorized.

[Publication checklist](publishing.md) · [Known platform/connector limits](release-status.md) · [First-time troubleshooting](setup.md#troubleshooting)
