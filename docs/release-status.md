# Release status — 1.0.22

Reviewed 2026-10-02. Windows, Linux and Hub share version 1.0.22. This release adds daily update checks with a persistent disable switch, explicit verified installation, startup validation and rollback. It includes phone sessions grouped by device, folded tool records, available-only G2 sessions, Windows startup recovery and direct or centralized Glance delivery. No user credentials are bundled.

## Validation

| Check | Result |
| --- | --- |
| Windows source | 240 passed, 3 Linux-only tests skipped; type checking and web build passed |
| Linux source | 242 passed, 1 Windows-only test skipped; type checking and web build passed |
| Windows desktop/install | Tray/startup tests and offline installer passed; pairing retention, running native process survival, guarded uninstall verified |
| Linux install | Offline installer with systemd user service passed; no system Node required; pairing retention and native process survival verified |
| Notification relay | Five tests cover direct/central delivery, persistent retry after lost acknowledgement, restart deduplication, G2 suppression, expiration, scoped authentication and route controls |
| Updates | Nine tests cover release validation, checksum/size/redirect rejection, authentication, stale releases, persistent opt-out and cancellation; real Windows/Linux update and failed-health rollback preserved keys and native processes |
| Update UI | Explicit check/install and persistent disable control verified at 390 px; no horizontal overflow |
| Phone UI | Synthetic device grouping/filtering/selection and 320/390 px layout verified; tool folding and routing settings verified at 390 px |
| Packages | Hub production build passed; runtime packages use official verified Node 24.18.0 and locked production dependencies |

Linux validation used Ubuntu 26.04 LTS, x86_64, glibc 2.43 on a headless host. Development logs and detailed inventories are retained privately; release assets include SHA-256 checksums. Synthetic notification tests do not send real FCM messages. Physical phone/G2 delivery through the new center still requires registration and a live completion.

G2 fixtures cover a visible native list with top input and the latest ten messages, role arrows, full-width Chinese labels, single-line pixel/character truncation, rejection fallback to compact UTF-8 labels, tap-to-open without preceding swipe callbacks, coalesced live rows at the top, stable rows while browsing, refreshing on return, native full-text scrolling and lossless text parts. They cover native send/discard confirmation, late transcription, stale selections, mounting delays, menu order and voice editing/exit confirmation, menu-only interruption, native Sessions, stale responses and per-session notification suppression. Streaming chunks are coalesced into the latest snapshot; identical labels do not rebuild the list. New content remains deferred while browsing, and basic-mode clocks update only their native text container. Scroll and selection do not send images. Labels are cached while the mounted snapshot is unchanged. Header/footer tiles occupy 34,560 pixels in total, down from the prior full-screen 165,888 pixels; this is an area calculation, not a measured Bluetooth latency improvement.

Hub builds exclude desktop-only management/pairing modules and their CSS. Session management loads on first use; voice configuration loads at startup without creating its dialog. The official Pretext tables are packed losslessly at build time, and a regression compares every decoded glyph, range and kerning entry with the pinned package. Width measurements and text wrapping match the original.

The folded phone diagnostic keeps 60 gesture metadata entries in memory, excludes messages/audio/credentials and does not send them to the backend. Explicit rejection first tries compact labels when applicable, then permits one image-free comparison and a basic native view if needed; transport errors retain retry backoff. Startup/history and label-only fallback fixtures cover both page creation and later rebuilding. Simulator/mock success is not hardware acceptance.

## Known limitations

- **Full-width labels still need hardware acceptance.** The container and item width are 560 px. Both normal and basic pages first use pixel-measured labels under the documented 64-character limit. Compact 63-byte labels are retained only if shortening them succeeds on that same layout; a failed attempt does not carry that restriction into basic view. Earlier reports did not isolate a firmware byte limit. The text heading has its own pixel budget and does not inherit list-label byte limits.
- **G2 hardware acceptance remains pending for the latest changes:** scrolling, gestures, microphone/ASR latency and Bluetooth responsiveness need a physical-device pass. The native list owns scrolling and focus; expanded text also uses native scrolling. Native list rebuilds cannot restore a scroll position. Automatic new-message refresh therefore runs at most once every two seconds while at the input row; scrolling, reading and editing defer it until returning. Firmware that emits no scroll callback cannot be distinguished from an untouched list until it reports an index. Oversized messages require explicit menu navigation between parts because the public Hub API has bounded text payloads and no scroll-position setter. Each part is limited to 900 UTF-8 bytes and sent during page creation; this also stays below the simulator's 999-byte creation limit. No throughput or latency guarantee is made.
- **Claude is experimental.** Isolated lifecycle/channel/interrupt tests pass, but a successful real model response and cancellation have not completed acceptance. A delivered Escape means “Stop requested,” not “Stopped.”
- **Ordinary Codex CLI/Desktop observation is read-only.** It depends on local rollout files and was checked against Codex 0.159.1. Remote/cloud-only sessions are not covered. Remote prompt/control requires a connector-backed session. Future Codex format changes may require updates.
- **Linux packages are x64/glibc.** ARM64 is not hardware-tested; Alpine/musl is unsupported by these binaries. Terminal launch adapters have automated coverage, but Linux graphical desktops were not physically tested.
- **Windows binaries are unsigned.** Installation checks do not imply signing or store certification.
- **Glance needs separate sender configuration.** No Firebase credentials or user connection/speech keys are shipped. See [Glance](glance-push.md).

Watch changes, network loss, tray exit and monitoring-backend shutdown do not terminate native terminals or invent a completion. Completion notifications are per session, and the session actually displayed on G2 is suppressed while its viewing lease is valid.

This is a source, dependency and packaging review, not an independent security assessment. See [setup](../README.md), [release notes](../RELEASE_NOTES.md) and [connector limits](connectors.md).
