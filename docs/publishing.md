# Publish Even-Pilot 1.1.5

The release folder is `release/1.1.5`. Building packages does not publish them. This is a normal patch release; no npm distribution is included.

## GitHub

1. Commit the reviewed source changes and push them to [Liang-Chu/Even-Pilot](https://github.com/Liang-Chu/Even-Pilot). Check that `.local`, credentials, generated payloads and `outputs` remain ignored. Keep `package-lock.json` and third-party notices.
2. Open **Releases → Draft a new release**. Create tag **v1.1.5** on that source commit. Use title **Even-Pilot 1.1.5** and paste `RELEASE_NOTES.md` as the release body.
3. Attach these files from the release folder:

   - `Even-Pilot-1.1.5-Setup-x64.exe` — Windows installer.
   - `Even-Pilot-1.1.5-Setup-linux-x64.run` — Linux installer.
   - `Even-Pilot-1.1.5-windows.zip` and `Even-Pilot-1.1.5-linux-x64.tar.gz` — optional portable packages.
   - `even-pilot-1.1.5.ehpk` — Even Hub package.
   - `SHA256SUMS.txt`, `RELEASE_NOTES.md` and `SETUP.md`.

4. Leave **Set as a pre-release** unchecked, select **Set as the latest release**, then publish. This lets existing companions discover 1.1.5. Retain the documented known limitations. GitHub pre-releases are excluded from update checks. Installation still starts only when the user chooses Update. Keep installer filenames unchanged.
5. Open the published page while signed out and confirm all downloads are public. Verify GitHub's installer asset SHA-256 digests against `SHA256SUMS.txt`; the updater requires those asset digests. Do not attach inventories, logs, source-build folders, real keys or Firebase JSON files.

## Even Hub

1. Upload `even-pilot-1.1.5.ehpk` through your Even Hub publishing account.
2. Paste the text from [Even Hub description](even-hub-description.md). It includes the GitHub download and setup links.
3. Use your own current screenshots, the shared app icon and any other fields required by the publishing form. The description already states that a computer companion is required.
4. Install the submitted Hub package on your phone. Saved connection and voice settings should restore. Use matching 1.1.5 companions.

Desktop/Linux updates do not install this phone package. The G2 changes require this separate Hub upload/install.

## Device validation

Validate the release on a physical phone/G2 and a clean user installation:

1. Install both companions, pair through Tailscale and verify restart/autostart. On a fresh Linux shell, `even-pilot` and `even-pilot pair` should work without a full path.
2. Watch real Pi/Codex/Claude sessions, run a task in their original CLIs and verify live status, history and model/device. For ordinary Claude verify the installed hooks and test its next prompt. With two concurrent sessions, each finishing session should report independently; a Codex child finishing must not end its parent.
3. Unwatch a running session, disconnect/reconnect the network and exit the tray/backend. Original terminals must continue; network loss must not create a completion.
4. On G2, switch watched sessions, scroll, expand user/agent messages, and confirm input send/discard and app exit behavior. Check latency and clipping on current firmware.
5. Register Glance on the direct sender or center, then verify a real completion reaches the phone/G2. A session displayed by Even-Pilot on G2 should be suppressed. For relay mode, repeat after a short source/center interruption.
6. For optional voice or experimental Claude, complete a real transcription and Claude response/cancellation. Test success must come from actual results, not only a delivered request.

See [release status](release-status.md) for automated audit evidence and remaining acceptance limits.
