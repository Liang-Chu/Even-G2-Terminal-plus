# Application updates

This guide covers **Terminal+ 1.1.18**. See [release status](release-status.md) for verification and publication details.

Published installers come from [Liang-Chu/Even-G2-Terminal-plus Releases](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases). After installing Terminal+ 1.1.18, companions check that repository for public stable releases and install verified updates by default. Existing disabled preferences remain disabled. A due startup check begins after at least ten seconds; checks then run once a day. A failed check does not report “up to date” or interrupt monitoring.

## Migration from Even-Pilot

Run `Terminal-plus-1.1.18-Setup-x64.exe` on Windows or `sh ./Terminal-plus-1.1.18-Setup-linux-x64.run` on Linux once. Older companions still target the renamed repository and older asset names; GitHub redirects may not satisfy their verified updater, so use the installer for this migration.

The display name is **Terminal+**; commands and filenames use `terminal-plus` / `Terminal-plus`. Existing roots remain `%LOCALAPPDATA%\Programs\Even-Pilot`, `~/.local/lib/even-pilot` and `~/.local/share/even-pilot`; Linux retains `even-pilot.service`. `EVEN_PILOT_*` variables, saved configuration and integration/protocol identifiers remain supported. Keeping these names preserves connection keys, host identity, Watch and Glance settings. The native `even-pilot` command remains a compatibility alias; use `terminal-plus` in new instructions.

Existing npm setup helpers do not need to remain installed after a manual native upgrade; remove the old helper with `npm uninstall -g even-pilot` if desired. This does not uninstall the native companion.

## Windows and management page

1. Open **Updates** in each companion's own desktop page to update the computer serving that page. From the Windows tray, choose **Check for updates**, then **Update to …** when a version is available. Phone Hub has no companion update entry.
2. **Check now** only checks for a release. To install immediately, review the versions and choose **Update to …** on that computer, even when automatic updates are disabled.
3. When installation begins, the page announces the restart and closes the update dialog. Reopen the manager after installation; native CLI windows remain open and pairing keys are retained.

The tray starts the download/install directly and shows **Downloading update: …%** followed by **Installing update…**. Progress is polled more frequently during work. Update actions are disabled while a request or installation is in progress, and failures are shown directly; the tray does not open a browser to perform the update.

Clear **Automatic updates** to stop both scheduled checks and automatic installation on that computer. The preference persists across restarts and is shared by that computer's desktop manager, tray and Linux CLI. Manual checks and immediate installation remain available. An update already in progress is not duplicated. If an automatic attempt fails, that same version waits at least 24 hours before another automatic attempt, including after restart or rollback; manual retry remains available.

## Linux / SSH

```sh
~/.local/bin/terminal-plus update check
~/.local/bin/terminal-plus update
~/.local/bin/terminal-plus update status
~/.local/bin/terminal-plus update off
~/.local/bin/terminal-plus update on
```

`update` starts an immediate verified update in the background; `check` only checks. `on`/`off` govern scheduled checks and automatic installation together. `status` shows the installed version, preference and last result. No sudo or global npm update is needed. Source checkouts are not overwritten; use an installer-managed installation for automatic updates. Manual installation of the new EXE/.run remains available.

## Installation and verification

The updater uses the fixed public repository over HTTPS, an exact platform/version asset name and GitHub's SHA-256 digest. Missing digest, invalid release metadata, unexpected download hosts, size/hash mismatch or a changed release prevent installation. The digest validates the downloaded file against the release; this is not Windows Authenticode signing.

Installers retain old payload directories because working native terminals may still use them. The installer starts the new backend and checks its version. If startup fails, it restores the previous selection and attempts to restart it. Configuration, pairing keys, Watch and notification settings remain in their existing data directory. Existing terminals load connector changes when reopened, or Pi when reloaded while idle.

Windows first installation creates desktop and Start menu shortcuts. From 1.1.18, updates, reinstalls and rollback retain your deleted-shortcut choices, refresh existing links and migrate owned legacy links; unrelated shortcuts are not changed.

Update Windows to 1.1.18 for shortcut retention. Install **Hub 1.1.18** for supported sensitive-field answering on the existing G2 UI; companion 1.1.17 already supports its question protocol. Shared computer connections, bounded retries and Status/Devices filters remain available. **Updating a Windows/Linux companion does not replace Terminal+ on the phone.** Install `terminal-plus-1.1.18.ehpk` separately through Even Hub. Hub keeps app ID `local.terminalplus.app`. If moving from `local.evenpilot.app`, the portal may require a new listing/install and saved phone connections/voice keys may not transfer. Re-enter each computer's existing URL/key and your transcription key if needed. Companion keys, Watch and notification settings remain in their existing data directory.

## Control API

- `GET /api/updates`: installed/available version, automatic-update preference, phase/progress and last result.
- `POST /api/updates/check` with `{}`: explicit network check.
- `POST /api/updates/settings` with `{ "automaticChecks": false }`: disable scheduled checks and automatic installation; `true` enables both. The field name is retained for existing clients.
- `POST /api/updates/install` with `{ "version": "1.2.3" }`: explicitly install the version returned by a successful check. Revalidates release metadata before downloading; returns 202 while work continues.

All update endpoints require the computer's control key. Notification and relay credentials cannot install software or alter preferences. The desktop dialog is bound to its own companion; an unrelated relay server does not gain update control. The Hub app exposes no backend update controls; its `.ehpk` is updated separately in Even Hub.
