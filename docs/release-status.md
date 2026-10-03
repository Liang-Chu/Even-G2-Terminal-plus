# Release status — 1.1.5

1.1.5 limits each desktop manager to its serving companion. Only the phone restores a multi-computer viewing pool. Desktop notification forwarding has its own center URL and temporary registration key, without opening remote session streams or saving a remote viewer connection. Saving the same center without a new key preserves its dedicated relay credential and pending events. A two-step relay Save finishes against its captured source even if the dialog is closed programmatically; normal Close, Escape and reentry are blocked during that Save.

Checked 2026-10-03:

| Check | Result |
| --- | --- |
| Windows source | 360 passed, 6 Linux-only tests skipped; type checking and production build passed |
| Linux source | 363 passed, 3 Windows-only tests skipped; type checking and production build passed |
| Viewer scope | Desktop startup never contacts saved remote hosts, missing local credentials never fall back to a remote, and disconnecting an old remote viewer leaves its Watch unchanged; phone restoration still includes its saved computers |
| Notifications | Transient center registration happens only on explicit Save; desktop source stays local; same-center readback retains the route; existing-route credential rotation survives Close/Escape/reentry attempts and writes exactly once to the captured source; focused viewer/UI/relay tests passed 28/28 |
| Browser UI | Synthetic desktop shows one local session while the phone shows both devices; no desktop Other computers/local editor; URL/key/QR fits 640 × 323 px without scrolling; standalone center Save clears its key and adds no desktop session viewer |
| Documentation | Bilingual guides match local desktop, phone aggregation and independent forwarding setup; 144 links and 32 heading anchors passed |

Headless Linux `even-pilot open` prints a private authenticated manager link with its credential in the URL fragment, avoiding a manual desktop connection editor. Runtime packaging verifies inventories, identical Windows/Linux frontend assets, private credential exclusion and download checksums before publication. The installer lifecycle and old-version migration results below belong to 1.1.4; those scenarios were not repeated for this viewer/UI patch. Physical G2 verification remains pending, and the phone Hub package is installed separately.

## 1.1.4 audit evidence (historical)

1.1.4 fixes monitor restart coordination and stalled HTTP shutdown, simplifies desktop phone pairing, and indents G2 assistant rows. The new HTTP shutdown has a one-second connection drain and is idempotent; it closes only this server's connections before releasing the backend lock. Windows installation stops its own tray before shutdown and blocks competing starts while the installer is active. Older monitors are eligible for bounded process cleanup only after authenticated watcher-only shutdown acknowledgement, listener closure, and verification of their exact process identity and this installation's bundled runtime. Native CLI process trees are never terminated.

Checked 2026-10-03:

| Check | Result |
| --- | --- |
| Windows source | 349 passed, 6 Linux-only tests skipped; type checking and production build passed |
| Linux source | 352 passed, 3 Windows-only tests skipped; type checking and production build passed |
| HTTP shutdown | Unfinished phone upload closes in about one second; the backend lock is reacquired; concurrent close calls share one drain; independent source review found no lifecycle blocker |
| Windows desktop | Real isolated listener/process tests passed: old tray retires first, stalled acknowledged monitor is recovered, and unrelated/native processes survive; unknown ownership, watcher-only refusal, failed HTTP and false acknowledgement cannot trigger recovery |
| Published-old-version migration | Isolated Windows 1.1.0 → 1.1.4 update passed with an unfinished phone upload held open: wrong-version health failure rolled back correctly, the accepted version restarted, keys and disabled update preference persisted, and a working native process survived both attempts |
| Updates UI | Confirmed installation announces restart and closes the dialog; lost acknowledgements poll status without repeating installation; stale responses cannot affect another open target |
| Connection UI | Local URL/key/QR and equal copy buttons fit a 640 × 323 px dialog without scrolling; credentials are retained and closing clears the displayed key; phone/multi-computer behavior is unchanged |
| G2 reply formatting | Two leading spaces are included in pixel/character/compact-byte budgets and retained in the phone preview; focused message, scroll, reconnect and canvas tests passed |
| Documentation | Desktop Connect phone labels match the simplified panel; phone Connection and Other computers retain their existing names; setup links and anchors validated |

Physical G2 verification remains pending. Companion installation retains pairing keys; the matching phone `.ehpk` is installed separately. The audit evidence below is historical unless explicitly repeated above.

## 1.1.3 audit evidence (historical)

1.1.3 updates the session device filter to native HTML buttons using the existing black-and-white pixel theme. It changes no backend protocol or lifecycle behavior. Type checking and the production build pass; browser verification at 320 px and 390 px covers selected styling, wrapping, filtering and retaining the device selection after refresh. Independent code review confirms that filtering does not change connections, Watch, terminals or prompt targets. Unchanged device options retain their DOM/focus during status updates. Runtime packaging and credential/checksum validation are repeated for the new release; the full source, installer and updater results below belong to 1.1.2 and were not rerun for this UI patch.

## 1.1.2 audit evidence (historical)

1.1.2 is a normal patch release. Desktop phone pairing, saved remote viewing connections and Glance notification routes have separate controls. Rejected connection keys identify the affected computer. Windows updater HTTPS uses explicit address-family resolution with normal certificate validation; failed staging returns to idle and releases its download. Claude question history refreshes; explicit connector questions can use remote single-choice/free-text answers, with native G2 option lists and an Other editor. Updating a companion does not update the phone Hub package; install the matching `.ehpk` separately.

### 1.1.2 validation

Checked 2026-10-03:

| Check | Result |
| --- | --- |
| Windows source | 339 passed, 6 Linux-only tests skipped; type checking and web build passed |
| Linux source | 342 passed, 3 Windows-only tests skipped; type checking and web build passed |
| Windows desktop | Startup, installer-support and direct tray update tests passed; authenticated exact-version installation, progress and errors exercised with isolated transport |
| G2 choices | Native options retain firmware focus without rebuilding on scroll; Other opens the editor; stale or uncertain answers cannot become new prompts; existing conversation/activity fixtures pass |
| Claude questions | Ordinary transcript question/options display and mtime/size refresh; connector hook/channel/mailbox returns the documented updatedInput; cancellation, timeout, disconnect, stale run and duplicate-answer guards pass without a model call |
| Updater HTTPS | 21 updater tests pass, including real local HTTPS trust/hostname failures, streaming, redirects, abort/cancel, family fallback and failed-staging retry; actual public GitHub metadata and allowed installer HEAD redirect succeed on Windows |
| Connection UI | Isolated desktop pairing stays local while a remote session is selected; phone saved/add/edit and central-routing preview verified at 390 px with no horizontal overflow; settings GET/readback and authentication fixtures pass |
| Documentation | Bilingual quickstarts/setup and operator runbook added; local links and heading anchors checked; runtime packages include the guides |
| Packaged installation | Windows portable runtime and offline installer pass without system Node/npm; isolated 1.1.1-to-1.1.2 installation retains keys and a running native process, and guarded uninstall retains user data. Linux offline installation/reinstallation, non-systemd daemon, autostart, Firebase settings, key retention and native-process survival pass |

Release packaging verifies payload inventories, matching Windows/Linux frontend assets, credentials exclusion and download checksums before publication. Physical G2 and real logged-in Claude question acceptance of this patch are still pending. The systemd, automatic-update and failed-health rollback results below apply to 1.1.0; those scenarios were not repeated for this patch.

## 1.1.0 audit evidence (historical)

The following results were recorded for the 1.1.0 review on 2026-10-02. That audit fixed false Codex parent completion from copied child history, Windows delegated check results, interrupted update recovery, dead snapshot accumulation and monitoring failures from temporary storage errors. Ordinary Claude gained official read-only hooks with owned-settings cleanup, conservative child/background/cron tracking and queue-gap handling. Explicit Unwatch persists across later native tasks; Updates has no extra device selector. The Linux CLI is limited to monitoring/management/settings, includes Firebase and routing setup, and registers the command in supported shells. Daily update checks, explicit verified installation, health validation and rollback remain.

| Check | Result |
| --- | --- |
| Windows source | 308 passed, 6 Linux-only tests skipped; type checking and web build passed |
| Linux source | 311 passed, 3 Windows-only tests skipped; type checking and web build passed |
| Windows desktop/install | Tray/startup tests and offline installer passed; pairing retention, running native process survival, guarded uninstall verified |
| Linux install | Offline installer with systemd user service passed; no system Node required; pairing retention and native process survival verified |
| Notification relay | Five tests cover direct/central delivery, persistent retry after lost acknowledgement, restart deduplication, G2 suppression, expiration, scoped authentication and route controls |
| Updates | Thirteen tests cover release validation, checksum/size/redirect rejection, authentication, stale releases, persistent opt-out, cancellation, worker recovery and matching job results; real Windows/Linux update and failed-health rollback preserved keys and native processes |
| Linux CLI settings | Eight isolated tests cover routing, bounded credential/key-file reads, saved configuration retention, safe restart and errors; shell PATH registration also has three Linux-only tests |
| Storage recovery | Tests cover Watch persistence retry, dead snapshot cleanup and completion delivery only after durable journal writes; failed polling writes retain the previous cursor |
| Update UI | Three tests verify serving-computer binding, no selector, unavailable-host handling and fixed action targets; earlier 390 px layout had no horizontal overflow |
| Codex/Claude lifecycle | Copied child metadata cannot finish the Codex parent; ordinary Claude hooks, owner identity, missing-event/cron/background guards, custom Stop uncertainty, startup ordering, child approvals and persistent Unwatch have regression coverage |
| Dependencies | Full and production-only npm audit returned zero known vulnerabilities on 2026-10-02 |
| Phone UI | Synthetic device grouping/filtering/selection and 320/390 px layout verified; tool folding and routing settings verified at 390 px |
| Packages | Hub production build passed; runtime packages use official verified Node 24.18.0 and locked production dependencies |

Linux validation used Ubuntu 26.04 LTS, x86_64, glibc 2.43 on a headless host. Development logs and detailed inventories are retained privately; release assets include SHA-256 checksums. Synthetic notification tests do not send real FCM messages. The maintainer reported successful Windows notification delivery after pairing with the existing 1.0.22 Linux center; live delivery with the rebuilt 1.1.0 packages remains an acceptance check.

G2 fixtures cover a visible native list with top input and the latest ten messages, role arrows, full-width Chinese labels, single-line pixel/character truncation, rejection fallback to compact UTF-8 labels, tap-to-open without preceding swipe callbacks, coalesced live rows at the top, stable rows while browsing, refreshing on return, native full-text scrolling and lossless text parts. They cover native send/discard confirmation, late transcription, stale selections, mounting delays, menu order and voice editing/exit confirmation, menu-only interruption, native Sessions, stale responses and per-session notification suppression. Streaming chunks are coalesced into the latest snapshot; identical labels do not rebuild the list. New content remains deferred while browsing, and basic-mode clocks update only their native text container. Scroll and selection do not send images. Labels are cached while the mounted snapshot is unchanged. Header/footer tiles occupy 34,560 pixels in total, down from the prior full-screen 165,888 pixels; this is an area calculation, not a measured Bluetooth latency improvement.

Hub builds exclude desktop-only management/pairing modules and their CSS. Session management loads on first use; voice configuration loads at startup without creating its dialog. The official Pretext tables are packed losslessly at build time, and a regression compares every decoded glyph, range and kerning entry with the pinned package. Width measurements and text wrapping match the original.

The folded phone diagnostic keeps 60 gesture metadata entries in memory, excludes messages/audio/credentials and does not send them to the backend. Explicit rejection first tries compact labels when applicable, then permits one image-free comparison and a basic native view if needed; transport errors retain retry backoff. Startup/history and label-only fallback fixtures cover both page creation and later rebuilding. Simulator/mock success is not hardware acceptance.

## Known limitations

- **Full-width labels still need hardware acceptance.** The container and item width are 560 px. Both normal and basic pages first use pixel-measured labels under the documented 64-character limit. Compact 63-byte labels are retained only if shortening them succeeds on that same layout; a failed attempt does not carry that restriction into basic view. Earlier reports did not isolate a firmware byte limit. The text heading has its own pixel budget and does not inherit list-label byte limits.
- **G2 hardware acceptance remains pending for the latest changes:** scrolling, gestures, microphone/ASR latency and Bluetooth responsiveness need a physical-device pass. The native list owns scrolling and focus; expanded text also uses native scrolling. Native list rebuilds cannot restore a scroll position. Automatic new-message refresh therefore runs at most once every two seconds while at the input row; scrolling, reading and editing defer it until returning. Firmware that emits no scroll callback cannot be distinguished from an untouched list until it reports an index. Oversized messages require explicit menu navigation between parts because the public Hub API has bounded text payloads and no scroll-position setter. Each part is limited to 900 UTF-8 bytes and sent during page creation; this also stays below the simulator's 999-byte creation limit. No throughput or latency guarantee is made.
- **Claude is experimental.** Official hook tests cover ordinary-terminal observation, owner/start identity, background/cron blockers, custom Stop uncertainty, queue gaps, restarts and settings preservation. Its next prompt after hook activation establishes monitoring. Known additional Stop hooks and unreadable metadata fail closed; dynamically registered skill/runtime hooks and remote policies cannot be fully enumerated. A crash between committed observer metadata and journal delivery can lose a notification. A synthetic ordinary Windows hook measured about 0.55 seconds including about 0.1 seconds for owner lookup; tool-heavy turns can incur overhead. Real model response/cancellation still need acceptance. A delivered Escape means “Stop requested,” not “Stopped.”
- **Claude question answering is connector-only.** Ordinary monitored questions are readable but cannot be answered remotely. Supported connector questions wait up to five minutes; phone Cancel returns immediately to native handling without an answer. Multi-select stays native. G2 answers only short single-question forms; larger/multiple forms use phone/native review. Real CLI application of the answer and physical G2 interaction remain acceptance checks.
- **Ordinary Codex CLI/Desktop observation is read-only.** It depends on local rollout files and was checked against Codex 0.159.1. Remote/cloud-only sessions are not covered. Remote prompt/control requires a connector-backed session. Future Codex format changes may require updates.
- **Linux packages are x64/glibc.** ARM64 is not hardware-tested; Alpine/musl is unsupported by these binaries. Terminal launch adapters have automated coverage, but Linux graphical desktops were not physically tested.
- **Windows binaries are unsigned.** Installation checks do not imply signing or store certification.
- **Glance needs separate sender configuration.** No Firebase credentials or user connection/speech keys are shipped. See [Glance](glance-push.md).

Watch changes, network loss, tray exit and monitoring-backend shutdown do not terminate native terminals or invent a completion. Completion notifications are per session, and the session actually displayed on G2 is suppressed while its viewing lease is valid.

This is a source, dependency and packaging review, not an independent security assessment. See [setup](../README.md), [release notes](../RELEASE_NOTES.md) and [connector limits](connectors.md).
