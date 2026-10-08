# Publish Even-Pilot 1.1.8

The companion release folder is `release/1.1.8`. The renamed Terminal+ 1.1.10 Hub package is in `release/hub-1.1.10`; it works with Even-Pilot 1.1.8 companions. Building packages does not publish them. The separate Linux npm package embeds the verified installer; the source checkout stays private to npm.

## GitHub

1. Commit the reviewed source changes and push them to [Liang-Chu/Even-Pilot](https://github.com/Liang-Chu/Even-Pilot). Check that `.local`, credentials, generated payloads and `outputs` remain ignored. Keep `package-lock.json` and third-party notices.
2. Open **Releases → Draft a new release**. Create tag **v1.1.8** on that source commit. Use title **Even-Pilot 1.1.8** and paste `RELEASE_NOTES.md` as the release body.
3. Attach these files from the release folder:

   - `Even-Pilot-1.1.8-Setup-x64.exe` — Windows installer.
   - `Even-Pilot-1.1.8-Setup-linux-x64.run` — Linux installer.
   - `Even-Pilot-1.1.8-windows.zip` and `Even-Pilot-1.1.8-linux-x64.tar.gz` — optional portable packages.
   - `SHA256SUMS.txt`, `RELEASE_NOTES.md` and `SETUP.md`.

   Add `terminal-plus-1.1.10.ehpk` from `release/hub-1.1.10` for Hub users, together with `HUB_SHA256SUMS.txt`. Do not upload the old `even-pilot-1.1.8.ehpk` or `pilot-1.1.9.ehpk`; the submitted display name is Terminal+ and the package ID is `local.terminalplus.app`.

4. Leave **Set as a pre-release** unchecked, select **Set as the latest release**, then publish. This lets existing companions discover 1.1.8. Retain the documented known limitations. GitHub pre-releases are excluded from update checks. Installed companions with **Automatic updates** enabled check and install verified releases automatically; manual **Update** remains available. Keep installer filenames unchanged.
5. Open the published page while signed out and confirm all downloads are public. Verify GitHub's installer asset SHA-256 digests against `SHA256SUMS.txt`; the updater requires those asset digests. Do not attach inventories, logs, source-build folders, real keys or Firebase JSON files.
6. Update the availability notice in both root READMEs once Windows 1.1.8 and Terminal+ Hub 1.1.10 are public. Keep the npm link and the step-by-step setup commands.

## npm — Linux

`even-pilot@1.1.8` is already published as `latest`. The steps below record the release process; do not republish this immutable version.

1. Build from the reviewed Linux installer and its adjacent `SHA256SUMS.txt`:

   ```sh
   npm run release:npm -- /absolute/path/Even-Pilot-1.1.8-Setup-linux-x64.run
   ```

   The output is `outputs/npm-1.1.8-<random>/even-pilot-1.1.8.tgz`. Keep the generated package separate from the source checkout.
2. Inspect the packed file list, verify its installer digest, and test a normal-user Linux x64 installation with install scripts disabled. Run `even-pilot-setup`, open a new shell and check `even-pilot status`. Also verify existing-install upgrade, no downgrade, settings retention and uninstall. Put the verified tarball in `release/1.1.8` and record its checksum.
3. With a publish-authorized npm account, publish only that tarball:

   ```sh
   npm publish ./release/1.1.8/even-pilot-1.1.8.tgz --access public --tag latest --ignore-scripts
   ```

   For interactive publishing, open the new authorization link printed by npm and approve it with your existing passkey/security key. No `--otp` argument is needed for this browser flow. A granular token instead requires **Read and write (publish and stage)** and **Bypass two-factor authentication**; see [npm token settings](https://docs.npmjs.com/creating-and-viewing-access-tokens/). Never put npm tokens in the source or tarball. Package versions cannot be overwritten; verify before publishing.
4. Confirm `npm view even-pilot version` returns `1.1.8`, then install from the public registry as a clean Linux user. The user flow is `npm install -g even-pilot`, `even-pilot-setup`, then `even-pilot` in a new shell. No `sudo` is needed. The companion continues to use its own verified GitHub updater; npm publication does not replace the GitHub release.

## Even Hub

1. Upload `release/hub-1.1.10/terminal-plus-1.1.10.ehpk` through your Even Hub publishing account. Set the listing name to **Terminal+**, matching the manifest and device app name. The reviewer requires no `even` in the package name; this package omits it from both display name and `package_id`. The ID changes from `local.evenpilot.app` to `local.terminalplus.app`, so the portal may require a new app listing rather than another version of the old one.
2. Paste the text from [Even Hub description](even-hub-description.md). It includes the GitHub download and setup links.
3. Use your own current screenshots, the shared app icon and any other fields required by the publishing form. The description already states that a computer companion is required.
4. Install the submitted Hub package on your phone. Do not assume settings transfer across the new app ID. Re-enter each computer's existing URL/key and your voice transcription key if needed, then verify live sessions and voice settings. Use Even-Pilot 1.1.8 companions; Hub and companion versions need not match.

Desktop/Linux updates do not install this phone package. Do not mark a Hub-only GitHub `v1.1.10` release as Latest: companion updaters expect native installers matching that release tag. Upload to Hub independently or attach the Hub files to the companion `v1.1.8` release.

## Device validation

Validate the release on a physical phone/G2 and a clean user installation:

1. Install both companions, pair through Tailscale and verify restart/autostart. On a fresh Linux shell, `even-pilot` and `even-pilot pair` should work without a full path.
2. Watch real Pi/Codex/Claude sessions, run a task in their original CLIs and verify live status, history and model/device. For ordinary Claude verify the installed hooks and test its next prompt. With two concurrent sessions, each finishing session should report independently; a Codex child finishing must not end its parent.
3. Unwatch a running session, disconnect/reconnect the network and exit the tray/backend. Original terminals must continue; network loss must not create a completion.
4. On G2, switch watched sessions, scroll, expand user/agent messages, and confirm input send/discard and app exit behavior. Check latency and clipping on current firmware.
5. Register Glance on the direct sender or center, then verify a real completion reaches the phone/G2. A session displayed by Terminal+ on G2 should be suppressed. For relay mode, repeat after a short source/center interruption.
6. For optional voice or experimental Claude, complete a real transcription and Claude response/cancellation. Test success must come from actual results, not only a delivered request.

See [release status](release-status.md) for automated audit evidence and remaining acceptance limits.
