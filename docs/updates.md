# Application updates

Published installers come from [Liang-Chu/Even-Pilot Releases](https://github.com/Liang-Chu/Even-Pilot/releases). Installed companions automatically check for public stable releases and install verified updates by default. Existing disabled preferences remain disabled. A due startup check begins after at least ten seconds; checks then run once a day. A failed check does not report “up to date” or interrupt monitoring.

## Windows and management page

1. Open **Updates** in each companion's own desktop page to update the computer serving that page. From the Windows tray, choose **Check for updates**, then **Update to …** when a version is available. Phone Hub has no companion update entry.
2. **Check now** only checks for a release. To install immediately, review the versions and choose **Update to …** on that computer, even when automatic updates are disabled.
3. When installation begins, the page announces the restart and closes the update dialog. Reopen the manager after installation; native CLI windows remain open and pairing keys are retained.

The tray starts the download/install directly and shows **Downloading update: …%** followed by **Installing update…**. Progress is polled more frequently during work. Update actions are disabled while a request or installation is in progress, and failures are shown directly; the tray does not open a browser to perform the update.

Clear **Automatic updates** to stop both scheduled checks and automatic installation on that computer. The preference persists across restarts and is shared by that computer's desktop manager, tray and Linux CLI. Manual checks and immediate installation remain available. An update already in progress is not duplicated. If an automatic attempt fails, that same version waits at least 24 hours before another automatic attempt, including after restart or rollback; manual retry remains available.

## Linux / SSH

```sh
~/.local/bin/even-pilot update check
~/.local/bin/even-pilot update
~/.local/bin/even-pilot update status
~/.local/bin/even-pilot update off
~/.local/bin/even-pilot update on
```

`update` starts an immediate verified update in the background; `check` only checks. `on`/`off` govern scheduled checks and automatic installation together. `status` shows the installed version, preference and last result. No sudo or global npm update is needed. Source checkouts are not overwritten; use an installer-managed installation for automatic updates. Manual installation of the new EXE/.run remains available.

## Installation and verification

The updater uses the fixed public repository over HTTPS, an exact platform/version asset name and GitHub's SHA-256 digest. Missing digest, invalid release metadata, unexpected download hosts, size/hash mismatch or a changed release prevent installation. The digest validates the downloaded file against the release; this is not Windows Authenticode signing.

Installers retain old payload directories because working native terminals may still use them. The installer starts the new backend and checks its version. If startup fails, it restores the previous selection and attempts to restart it. Configuration, pairing keys, Watch and notification settings remain in their existing data directory. Existing terminals load connector changes when reopened, or Pi when reloaded while idle.

**Updating a Windows/Linux companion does not replace Terminal+ on the phone.** Upload/install `terminal-plus-1.1.10.ehpk` separately through Even Hub; it works with Even-Pilot 1.1.8 companions. Terminal+ changes the Hub app ID to `local.terminalplus.app`; the portal may require a new listing/install. Saved phone connections and voice keys may not transfer. Re-enter each computer's existing URL/key and your transcription key if needed. Companion keys, Watch and notification settings remain in their existing data directory.

## Control API

- `GET /api/updates`: installed/available version, automatic-update preference, phase/progress and last result.
- `POST /api/updates/check` with `{}`: explicit network check.
- `POST /api/updates/settings` with `{ "automaticChecks": false }`: disable scheduled checks and automatic installation; `true` enables both. The field name is retained for existing clients.
- `POST /api/updates/install` with `{ "version": "1.2.3" }`: explicitly install the version returned by a successful check. Revalidates release metadata before downloading; returns 202 while work continues.

All update endpoints require the computer's control key. Notification and relay credentials cannot install software or alter preferences. The desktop dialog is bound to its own companion; an unrelated relay server does not gain update control. The Hub app exposes no backend update controls; its `.ehpk` is updated separately in Even Hub.
