# Release status — Terminal+ 1.1.12

Terminal+ **1.1.12** defaults new or model-less OpenAI voice configurations to **GPT Transcribe**, with streamed text. Explicit Whisper selections, providers and API keys remain saved. The companion and Hub share the version and keep Hub ID `local.terminalplus.app`. GitHub and npm publication of 1.1.12 remain pending verification; physical phone/G2 acceptance is unverified.

Existing Even-Pilot users still need one manual installer upgrade because older verified updaters may reject the repository redirect or renamed assets. Existing data, service and configuration identifiers remain for settings retention. See [migration](updates.md#migration-from-even-pilot).

## Current 1.1.12 verification — 2026-10-07–08

| Check | Result |
| --- | --- |
| Voice regression | 50 targeted tests passed, covering default GPT Transcribe and preservation of explicit Whisper/provider/key settings |
| Windows source | 444 tests: 436 passed, 8 skipped, 0 failed |
| Windows desktop | All three C# desktop test suites passed |
| Windows final packages | Final portable package and actual offline 1.1.11 → 1.1.12 installer reinstall/upgrade passed. Fixture cleanup completed |
| Windows update worker | Failed-health update rolled back; successful update restarted the new backend |
| Linux source | 444 tests: 441 passed, 3 skipped; type checking and frontend build passed |
| Linux final installer | Actual same-version 1.1.12 reinstall and 1.1.11 → 1.1.12 native upgrade passed |
| Linux update worker | Failed-health update rolled back; successful update restarted the new backend |
| Linux npm package | Final local fresh-install and custom-root upgrade checks passed all 84 assertions; five-file allowlist passed |
| Linux artifact verification | All 634 native manifest hashes matched; source/frontend matched the tested build. No Linux fixture processes remain |
| Hub package | Official CLI produced a 118,807-byte `.ehpk`; physical phone installation and G2 acceptance remain unverified |
| Publication | npm authorization link expired; publication retry is pending. GitHub 1.1.12 is not yet published |

## Previous 1.1.11 verification — 2026-10-07

The rebranding release used [Liang-Chu/Even-G2-Terminal-plus](https://github.com/Liang-Chu/Even-G2-Terminal-plus), `Terminal-plus` native assets and `terminal-plus` commands. At publication, [GitHub v1.1.11](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases/tag/v1.1.11) was verified as stable Latest, and [terminal-plus@1.1.11](https://www.npmjs.com/package/terminal-plus) as public npm `latest`. The repository URL and SHA-512 digest matched its final package. These historical results do not establish 1.1.12 publication or hardware acceptance.


| Check | Result |
| --- | --- |
| Windows source | 439 tests: 431 passed, 8 skipped |
| Linux source | 439 tests: 436 passed, 3 skipped |
| Windows desktop | All three C# desktop test suites passed |
| Windows portable package | Primary and compatibility launchers were byte-identical; the packaged `--check` entry point passed |
| Windows migration | Actual offline installer upgraded 1.1.8 to 1.1.11 while retaining legacy registration, connection key and running native workers |
| Windows update worker | Failed-health update rolled back; successful update restarted the new backend |
| Linux migration | Actual native installer upgraded 1.1.8 to 1.1.11 in a non-systemd installation |
| Linux update worker | Failed-health update rolled back; successful update restarted the new backend |
| Linux npm package | Five-file allowlist passed; local fresh-install and custom-root upgrade checks passed all 85 assertions |
| Public npm installation | At publication, `terminal-plus@1.1.11` was public/`latest`; repository URL and final tarball SHA-512 match. Unauthenticated public-registry Linux fresh installation passed 39 assertions. Fixtures were cleaned; live installations were untouched |
| Public GitHub release | At publication, stable Latest `v1.1.11` had 14 assets with matching sizes and SHA-256 digests. Windows/Linux installers and Hub package were downloaded without authentication and matched the tested artifacts; both platform update parsers accepted the new repository and installer names |
| Production dependencies | npm audit reports zero known vulnerabilities; checked 2026-10-07 |
| Hub package | Official CLI 0.1.14 produced a 118,793-byte `.ehpk`, retaining SDK 0.0.16 / Even App 2.2.10 requirements. Physical installation and G2 acceptance remain unverified |

The 1.1.11 checks do not replace physical Windows menus, Linux graphical/systemd startup, real voice/Claude response and cancellation, or phone/G2 acceptance. The older records below describe their original versions and dates.

## Previous release evidence

Hub-only rename reviewed 2026-10-07: the manifest, phone branding and default G2 heading were **Terminal+ 1.1.10**. The earlier rename retained `local.evenpilot.app`; this package used `local.terminalplus.app`, and the filename was `terminal-plus-1.1.10.ehpk`. Packaging rejected the reserved word in either the app name or package ID. Both frontend builds and 74 G2, pairing and settings regression tests passed. The official CLI produced a 118,798-byte package with the same SDK 0.0.16 / Even App 2.2.10 floor. Windows/Linux/npm were still 1.1.8. The app ID changes the phone app's storage namespace: existing backend keys still work, but phone connections and voice keys may need entering again. Physical installation still needs a phone check.

The 1.1.8 baseline fixed Claude queue starvation and delayed child-event accounting, added G2 agent-task details, removed generated context from G2 questions, preserved newer voice settings and supported user-owned Firebase sender projects. G2 navigation also skipped obsolete queued text writes, sent the selected page before saving preferences and wrapped only visible preview rows. Its final source checks and independent reviews passed.

Reviewed 2026-10-03:

| Check | Result |
| --- | --- |
| Windows source | 422 passed, 6 Linux-only tests skipped; type checking and production build passed |
| Linux source | 425 passed, 3 Windows-only tests skipped; type checking and production build passed |
| G2 navigation regression | Obsolete queued text is skipped; page/bar writes precede remembered-session saves; rapid switches coalesce unsent saves; saved selection survives pause, failure and disposal. Independent wrapping comparison passed 1,110 full and 3,330 bounded-prefix cases. No hardware latency claim |
| Windows desktop | Startup, autostart, scoped installer ownership and direct authenticated tray-update checks passed |
| Final installer reinstall | Actual 1.1.8 Windows Setup EXE passed four acceptance groups: fresh/same-version installs, two quiet tray/backend starts, authenticated manager/pairing, retained key/Watch/preferences and protected native-worker/uninstall behavior. Linux final `.run` and published npm package passed 131 assertions for literal same-version reinstalls, start/stop, global command, pairing/QR and key/Watch/forwarding retention. All fixtures/processes were cleaned; Windows startup/shortcuts and live Windows/NUC installations were unchanged. Windows interactive menus and Linux graphical/systemd startup were not part of this isolated acceptance |
| Independent reviews | G2 projection/detail selection, voice persistence, Firebase validation and bounded Pi/Codex task metadata passed; Claude reordered-event, equal-time and recovery guards independently reviewed with 25/25 tests |
| NUC actual-data copy | 156 queued events drained; acknowledged legacy children no longer counted as confirmed active. Parent activity and conservative completion guards retained; no completion emitted. Live data and native processes were not modified |
| Production dependencies | npm audit reports zero known vulnerabilities; checked 2026-10-03 |
| Linux npm distribution | Eight bootstrap tests and 82 isolated npm/native installation checks passed on NUC/npm 11.16.0, including scripts disabled/enabled, shared launcher prefix, 1.1.6 upgrade, custom root, settings and native-process retention. Five-file allowlist, embedded installer digest and publish dry-run passed. `even-pilot@1.1.8` is published as `latest`; unauthenticated public download matches the final SHA-512 and public-registry installation passed 38 checks. Fixture directories/processes were removed; live NUC services were unchanged |

Runtime packaging checks allowed production files and bundled dependencies, inventories, matching Windows/Linux frontend assets, credential exclusion and SHA-256 digests. Installer smoke checks use isolated installations and synthetic credentials, without model turns or real push delivery. Earlier detailed audit records are available in [the 1.1.7 source history](https://github.com/Liang-Chu/Even-G2-Terminal-plus/blob/a2844a8d04fad6c1e2128a361937cf6917d2bb1a/docs/release-status.md).

## Behavior and limits

- **Counts need lifecycle evidence.** Late Claude child events use independent timestamps. Conflicting events in the same millisecond retain uncertainty until a later authoritative event; they do not invent completion. Older unresolved state can show `?` until a fresh trusted parent Stop with an explicitly empty background registry confirms previously acknowledged children. Missing transcripts, custom Stop hooks, gaps and disconnected processes never imply success.
- **Agent-task descriptions depend on the tool.** Pi's optional official subagent extension supplies explicit task metadata, including outstanding queued workers. Ordinary Codex reports verified active child identities without inferring their tasks from copied history. Claude and other integrations may have no task description. Details are bounded to sixteen children and displayed as a snapshot while reading.
- **G2 still needs a physical-device acceptance pass.** Native lists own focus/scrolling; expanded text uses native scrolling. Automatic history refresh is deferred while browsing or editing. A message part stays under 900 UTF-8 bytes; larger messages use explicit part navigation because the public SDK has no scroll-position setter. Firmware controls list row spacing. Long-label acceptance and Bluetooth/ASR responsiveness cannot be established by mocks alone.
- **Claude support is experimental.** Its next prompt after hook activation establishes ordinary-terminal monitoring. Tests cover hooks, owner identity, background/cron blockers, restarts, custom-hook uncertainty and reordered events. Dynamically registered hooks and remote policies cannot be fully enumerated. Real model response, connector question answers and cancellation still need acceptance; a delivered Escape means Stop requested.
- **Ordinary Codex CLI/Desktop and Claude observation is read-only.** Remote prompts/control need a connector-backed session. Codex relies on local rollout files; cloud-only sessions are not covered and future CLI formats may require updates. G2 supports short single-question choices; multi-select and larger forms remain on phone/native terminals.
- **Platforms:** release installers target Windows 10/11 x64 and Linux x64/glibc. Windows binaries are unsigned. ARM64, Alpine/musl and Linux graphical desktops have not been physically validated.
- **Notifications:** configure a direct sender or one forwarding center and register Glance separately. No Firebase, connection or speech credentials are shipped. The session actually displayed on G2 suppresses its own completion notification while the viewing lease is valid.

Updating a companion retains its pairing and settings and leaves native CLI sessions running. Install `terminal-plus-1.1.12.ehpk` separately with Terminal+ 1.1.12 companions. Watch, Unwatch, network loss and monitoring shutdown do not terminate native terminals.

See [setup](../README.md), [release notes](../RELEASE_NOTES.md), [connector limits](connectors.md) and [Glance setup](glance-push.md).
