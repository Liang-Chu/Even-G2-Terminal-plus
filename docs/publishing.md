# Publish Terminal+ 1.1.15

This guide covers the unified Windows/Linux companion and Terminal+ Hub release **1.1.15**. See [release status](release-status.md) for verification and publication details. Building packages does not publish them; record download and npm availability after verifying the public assets. The source package retains `private: true`.

## GitHub

1. Commit reviewed source changes and push to [Liang-Chu/Even-G2-Terminal-plus](https://github.com/Liang-Chu/Even-G2-Terminal-plus). Check that `.local`, credentials, generated payloads and `outputs` remain ignored. Keep `package-lock.json` and third-party notices.
2. Build and validate native packages, Hub package, standalone guides and checksums. Stage the reviewed files in `release/github-1.1.15` only after the checks pass; use [release status](release-status.md) to record the actual evidence.
3. Open **Releases → Draft a new release**. Create tag **v1.1.15** on the reviewed source commit. Use title **Terminal+ 1.1.15** and only the first **Terminal+ 1.1.15** section of `RELEASE_NOTES.md` as the release body; omit the labeled history. Attach:

   - `Terminal-plus-1.1.15-Setup-x64.exe` — Windows installer.
   - `Terminal-plus-1.1.15-Setup-linux-x64.run` — Linux installer.
   - `Terminal-plus-1.1.15-windows.zip` and `Terminal-plus-1.1.15-linux-x64.tar.gz` — optional portable packages.
   - `terminal-plus-1.1.15.ehpk` — phone/G2 package.
   - `SHA256SUMS.txt`, `HUB_SHA256SUMS.txt`, `RELEASE_NOTES.md` and `SETUP.md`.

4. For a validated stable release, leave **Set as a pre-release** unchecked and select **Set as the latest release**. The new companion updater requires installer filenames matching the release tag and GitHub's SHA-256 asset digests. Pre-releases are excluded from update checks. Do not mark a Hub-only release as Latest without matching native installers.
5. Open the published page while signed out and verify every download and its digest against the staged checksums. Do not attach inventories, logs, source-build folders, real keys or Firebase JSON files.
6. Verify both READMEs' links and instructions against the public assets, then update the publication status. Existing Even-Pilot users must install the new companion manually once; repository redirects may not satisfy older updaters. See [migration](updates.md#migration-from-even-pilot).

## npm — Linux

Publish the separate **terminal-plus** setup package after validating the matching native installer. Never publish the private source checkout. Check registry availability and account permission before publishing; npm versions are immutable.

1. Build from the reviewed Linux installer and its adjacent `SHA256SUMS.txt`:

   ```sh
   npm run release:npm -- /absolute/path/Terminal-plus-1.1.15-Setup-linux-x64.run
   ```

   The output is `outputs/npm-1.1.15-<random>/terminal-plus-1.1.15.tgz`. Inspect the packed file allowlist and installer digest. Keep this package separate from the source checkout.
2. Test a normal-user Linux x64 installation with install scripts disabled and enabled. Run `terminal-plus-setup`, open a new shell and check `terminal-plus status`. Verify upgrade from Even-Pilot, no downgrade, saved identity/Watch/notification settings, compatibility alias and uninstall. Copy the verified tarball to `release/1.1.15` and record its checksum.
3. With a publish-authorized npm account, publish only that tarball:

   ```sh
   npm publish ./release/1.1.15/terminal-plus-1.1.15.tgz --access public --tag latest --ignore-scripts
   ```

   Use npm's authorization flow for the authorized account. Never put npm credentials in the source or tarball.
4. Confirm `npm view terminal-plus version` returns `1.1.15`, verify the public tarball digest, and install from the public registry as a clean Linux user. The user flow is `npm install -g terminal-plus`, `terminal-plus-setup`, then `terminal-plus` in a new shell. No `sudo` is needed. Only then record verified public availability in release status. Companion updates continue to use verified GitHub Releases.

## Even Hub

1. Upload the validated `terminal-plus-1.1.15.ehpk` through your Even Hub publishing account. Set the listing name to **Terminal+**, matching the manifest and device app name. Keep package ID `local.terminalplus.app`; the name and ID omit the reviewer's reserved word.
2. Paste [Even Hub description](even-hub-description.md), and use your own current screenshots, shared app icon and other fields required by the form. The description states that a computer companion is required.
3. When migrating a listing from `local.evenpilot.app`, the portal may require a new listing/install. Do not assume phone settings transfer. Re-enter each computer's existing URL/key and your voice transcription key if needed, then verify live sessions and voice settings with Terminal+ 1.1.15 companions.

Desktop/Linux updates do not install the phone package. Publish/install it separately even when all packages share a version.

## Device validation

Validate the release on a physical phone/G2 and a clean user installation:

1. Install both companions, pair through Tailscale and verify restart/autostart. On a fresh Linux shell, `terminal-plus` and `terminal-plus pair` should work without a full path.
2. Watch real Pi/Codex/Claude sessions, run a task in their original CLIs and verify live status, history and model/device. For ordinary Claude verify the installed hooks and test its next prompt. With two concurrent sessions, each finishing session should report independently; a Codex child finishing must not end its parent.
3. Unwatch a running session, disconnect/reconnect the network and exit the tray/backend. Original terminals must continue; network loss must not create a completion.
4. On G2, switch watched sessions, scroll, expand user/agent messages, and confirm input send/discard and app exit behavior. Check latency and clipping on current firmware.
5. Register Glance on a direct sender or center, then verify a real completion reaches the phone/G2. A session displayed by Terminal+ on G2 should be suppressed. For relay mode, repeat after a short source/center interruption.
6. For optional voice or experimental Claude, complete a real transcription and Claude response/cancellation. Test success must come from actual results, not only a delivered request.

See [release status](release-status.md) for automated audit evidence and remaining acceptance limits.
