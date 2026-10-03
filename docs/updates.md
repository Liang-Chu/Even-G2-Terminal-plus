# Application updates

Published installers come from [Liang-Chu/Even-Pilot Releases](https://github.com/Liang-Chu/Even-Pilot/releases). Each backend checks at startup when its last check is older than 24 hours, then once a day. A failed check does not report “up to date” or interrupt monitoring. Only public stable releases are considered.

## Windows and management page

1. Open **Updates** in the desktop page to update the computer serving that page. In the phone Hub it targets the active computer when the dialog opens. There is no additional computer selector. From the Windows tray, choose **Check for updates**, then **Update to …** when a version is available.
2. Review the installed and available versions. Choose **Update to …** to start downloading and installing on that computer.
3. When installation begins, the page announces the restart and closes the update dialog. Reopen the manager after installation; native CLI windows remain open and pairing keys are retained.

The tray starts the download/install directly and shows **Downloading update: …%** followed by **Installing update…**. Progress is polled more frequently during work. Update actions are disabled while a request or installation is in progress, and failures are shown directly; the tray does not open a browser to perform the update.

Clear **Automatically check for updates** to disable background release requests and reminders on that computer. The preference persists across restarts and applies to all connected screens. Manual **Check now** remains available. Installation never starts automatically just because a release was found.

## Linux / SSH

```sh
~/.local/bin/even-pilot update check
~/.local/bin/even-pilot update
~/.local/bin/even-pilot update status
~/.local/bin/even-pilot update off
~/.local/bin/even-pilot update on
```

`update` starts the verified update in the background; `status` shows the installed version, preference and last result. No sudo or global npm update is needed. Source checkouts are not overwritten; use an installer-managed installation for in-app updates. Manual installation of the new EXE/.run remains available.

## Installation and verification

The updater uses the fixed public repository over HTTPS, an exact platform/version asset name and GitHub's SHA-256 digest. Missing digest, invalid release metadata, unexpected download hosts, size/hash mismatch or a changed release prevent installation. The digest validates the downloaded file against the release; this is not Windows Authenticode signing.

Installers retain old payload directories because working native terminals may still use them. The installer starts the new backend and checks its version. If startup fails, it restores the previous selection and attempts to restart it. Configuration, pairing keys, Watch and notification settings remain in their existing data directory. Existing terminals load connector changes when reopened, or Pi when reloaded while idle.

**Updating a Windows/Linux companion does not replace the phone Hub package.** To receive the 1.1.4 G2 changes, upload/install `even-pilot-1.1.4.ehpk` separately through Even Hub. Existing phone connection and voice settings remain saved.

## Control API

- `GET /api/updates`: installed/available version, automatic-check preference, phase/progress and last result.
- `POST /api/updates/check` with `{}`: explicit network check.
- `POST /api/updates/settings` with `{ "automaticChecks": false }`: disable background checks and reminders; `true` enables them.
- `POST /api/updates/install` with `{ "version": "1.2.3" }`: explicitly install the version returned by a successful check. Revalidates release metadata before downloading; returns 202 while work continues.

All update endpoints require the computer's control key. Notification and relay credentials cannot install software or alter preferences. The dialog keeps its target fixed until it is closed; an unrelated relay server does not gain update control.
