# Release status — Terminal+ 1.1.16

## Current 1.1.16 candidate

Shared saved-computer lists are persisted privately on paired companions. A phone or browser needs one initial URL/key; visible viewers learn and propagate the list through reachable paired computers. Device IDs deduplicate aliases, while local desktop transport stays local. Keyless deletion records prevent stale caches and returning offline devices from restoring removed connections. Synchronization does not change Watch, native terminals, session routing or notification settings.

Windows source verification passed: 534 tests, 525 passed, 9 platform skips and no failures; typecheck, production build and all three C# desktop suites passed. Shared-list regressions cover durable storage, concurrent edits/removals, stale caches, identity changes, address updates, credentials and retry-budget preservation. Native package verification and publication are in progress. Physical phone/G2 acceptance is not confirmed. The public release verified below remains 1.1.15 until a new publication is recorded.

## Previous 1.1.15 publication and verification

**Terminal+ 1.1.15** provides the Pi/Codex/Claude browser portal for Windows/Linux. Browser and phone connect each saved computer immediately, then allow up to five automatic retries per startup/manual reconnect cycle, each 30 seconds after failure. Successes and passive foregrounding do not reset the budget; foregrounding does not skip the wait. Exhausted computers stay Offline until targeted Reconnect or a fresh app startup. HTTP 401 stops retries with Key rejected. Compact Status and Devices dropdowns provide All/Watched/Running and multiple-computer filtering. Watch remains per source computer.

## Current 1.1.15 verification — 2026-10-08

| Check | Result |
| --- | --- |
| Windows source | 493 tests: 484 passed, 9 platform-related skips, 0 failed; typecheck and production build passed. Three C# desktop suites passed |
| Retry and G2 regressions | Initial attempt plus five retries at 30-second intervals; exhausted and rejected-key states stay stopped through passive foreground/resume. Healthy lifecycle suspension resumes without spending a retry. Targeted reconnect retains other streams and Watch; selected G2 status ignores unrelated offline computers |
| Browser acceptance | Final production frontend tested at 390 × 844 using two isolated HTTP bridges and synthetic histories/keys. Status single selection, device multiple selection, and independent online/offline sessions worked. Exhausted device displayed Offline with Reconnect; no new stream request for 78 seconds. Manual Reconnect restarted only that device, preserved Watch and the other stream, and the online G2 preview retained its selected computer. No real prompts or push delivery |
| Windows packages | Final ZIP smoke and manifest hashes passed. Final offline installer/reinstall checks passed, including saved keys, existing settings, owned-hook cleanup and native-process survival. The 1.1.14 → 1.1.15 upgrade also passed. The public GitHub installer was downloaded and its SHA-256 matched the reviewed artifact |
| Linux packages | Frozen source verified 256/256; all 232 functional files match the tested candidate, so its 94/94 targeted tests and typecheck evidence were reused. Final native fresh install and npm fresh install passed. A clean install of public registry `terminal-plus@1.1.15` passed all 39 assertions with empty user/global npm configuration, and published SHA-512 integrity matched the reviewed tarball. All 636 payload hashes and three downloaded artifacts verified. Sixteen installer/bootstrap/update sources match the verified 1.1.14 baseline; its upgrade/rollback checks were reused, not rerun for 1.1.15 |
| Hub package | Official CLI checks passed, 121,286 bytes, SDK 0.0.16 / Even App 2.2.10 floor. Physical phone/G2 acceptance remains unverified |
| Publication and hardware | [GitHub v1.1.15](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases/tag/v1.1.15) is public, stable and Latest with all 14 assets verified. Windows/Linux updater metadata resolves the reviewed installer hashes. [npm terminal-plus](https://www.npmjs.com/package/terminal-plus) latest is 1.1.15 and its SHA-512 integrity matches the reviewed tarball. User reports the byte-identical Hub package uploaded; Hub approval and physical phone/G2 acceptance are not confirmed |

These package results were recorded after the artifacts were built. Live Windows/NUC installations were not upgraded in this verification; the NUC service remained active with its original process identity.

Earlier checks below apply only to their named versions, not to the current 1.1.15 changes.

## Previous 1.1.14 candidate verification — 2026-10-08

The unpublished 1.1.14 candidate added the Windows/Linux browser portal for Pi, Codex and Claude. Each browser reaches saved computers directly, independently of phone connections. Its recorded checks do not establish the 1.1.15 reconnect/filter behavior or physical phone/G2 acceptance.

| Check | Result |
| --- | --- |
| Windows source | 477 tests: 468 passed, 9 platform-related skips, 0 failed; typecheck and production build passed |
| Windows desktop | All three C# suites passed |
| Portal routing and reconnect | Scoped sessions with identical native IDs remain separate; tests cover all three CLIs, read-only history, late history/catalog responses, removed/offline hosts, replaced credentials, overlapping opening requests, saved connections and Unwatch without closing terminals |
| Browser acceptance | Two isolated actual HTTP bridges served the production frontend. Pi/Codex/Claude appeared from both sources; device filters, remote history, live selected conversation, read-only ordinary Codex/Claude, remote Pi input and saved connection removal/re-add worked. API audit confirmed commands stayed on the target and history/viewer removal did not change Watch. Updates stayed on the serving computer. Synthetic histories and credentials; no real model calls or push delivery |
| Windows packages | Final portable and actual 1.1.13 → 1.1.14 installer checks passed: offline install, retained keys/configuration and native-process survival |
| Windows update | Actual --update passed failed-health rollback, healthy restart and saved preference/key retention |
| Linux packages | All 255 frozen source files verified; 42 Linux/platform/bootstrap tests passed. Native fresh daemon installation, systemd 1.1.13 → 1.1.14 upgrade and failed-health rollback passed; local npm fresh/custom-root upgrade passed all 84 assertions. Final Fleet/desktop/history/connection regressions passed 39/39 on Linux; final native and npm fresh-install checks passed. Final payload contains 636 files; hashes verified |
| Hub package | Official CLI package checks passed using SDK 0.0.16 / Even App 2.2.10 floor. Physical phone/G2 acceptance remains unverified |
| Publication and hardware | GitHub/npm 1.1.14 publication and physical phone/G2 acceptance remain pending. Public latest was 1.1.11 when checked on 2026-10-08. Live NUC is still on companion 1.1.13 |

The records below are historical; they do not establish current publication or physical-device acceptance.

## Previous 1.1.13 companion fix

**1.1.13** fixes Claude observation of large native transcripts through bounded head/tail reads and recovers blocked queues containing definitely retired events with no recoverable first prompt. Missing history and uncertain/live events still do not establish completion. Existing Terminal+ Hub installations continue to work with the fixed companion. The native companion has been installed on the NUC with its live Claude process preserved; GitHub/npm publication and physical phone/G2 acceptance remain pending.

Existing Even-Pilot users still need one manual installer upgrade because older verified updaters may reject the repository redirect or renamed assets. Existing data, service and configuration identifiers remain for settings retention. See [migration](updates.md#migration-from-even-pilot).

### 1.1.13 verification — 2026-10-08

| Check | Result |
| --- | --- |
| Windows source | 457 tests: 448 passed, 9 skipped, 0 failed; includes the shared reader, retired-event queue and large-transcript observer regression checks |
| Windows desktop | All three C# desktop test suites passed |
| Windows final packages | Final portable smoke and actual 1.1.11 → 1.1.13 installer reinstall/upgrade smoke passed |
| Windows update worker | Actual 1.1.11 → 1.1.13 update passed failed-health rollback, healthy restart, saved preference/key retention and native-process survival |
| Linux source | 457 tests: 454 passed, 3 skipped |
| Linux final installer | Actual same-version 1.1.13 reinstall and 1.1.11 → 1.1.13 upgrade passed |
| Linux update worker | Failed-health rollback and successful restart checks passed, including the exact prior 1.1.7 installation used for the NUC upgrade |
| Linux runtime verification | Independent checks verified 252 source files and all 635 native manifest files |
| Linux npm package | Local fresh-install and custom-root upgrade checks passed all 84 assertions; five-file allowlist passed |
| Actual NUC transcript, read-only | A 42 MiB Claude transcript required 2,162,689 bytes of reads; retained 97 visible messages and matching session identity. This did not update the live backend |
| NUC deployment | Official installer `--update` upgraded live 1.1.7 → 1.1.13 and exited 0. Verification retained the entire configuration hash, all 16 Watch flags and original Claude PID 2800624/start identity, and confirmed backend 1.1.13 with the new repository. The old 1,024-event queue drained to zero; a fresh actual Claude hook arrived automatically without a synthetic event or paid test prompt. The large session now reports 41 recent messages, `live: true`, `monitored: true` and `runtimeStatus: running`; monitoring also reports it watched/running. Recent-history and automated G2-eligibility checks passed; physical phone/G2 acceptance still requires the user check |
| NUC phone/G2 APIs | Over the Tailscale address, authenticated history and runtime-state requests returned HTTP 200 with the phone origin allowed. History retained 54 user and 46 assistant messages; connected runtime retained 21 user and 19 assistant messages. Windows could reach the NUC web endpoint. These API checks do not establish physical G2 rendering |
| Hub package | Official CLI produced a 118,808-byte `.ehpk`; physical phone installation and G2 acceptance remain unverified |
| Publication | GitHub and npm 1.1.13 publication pending |

## Previous 1.1.12 verification — 2026-10-07–08

These results describe the 1.1.12 voice-default release and do not establish 1.1.13 acceptance or publication.


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

Updating a companion retains its pairing and settings and leaves native CLI sessions running. Existing Terminal+ Hub installations work with the 1.1.13 companion fix; install a new `.ehpk` separately only when updating Hub. Watch, Unwatch, network loss and monitoring shutdown do not terminate native terminals.

See [setup](../README.md), [release notes](../RELEASE_NOTES.md), [connector limits](connectors.md) and [Glance setup](glance-push.md).
