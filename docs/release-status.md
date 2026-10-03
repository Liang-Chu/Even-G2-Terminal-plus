# Release status — 1.1.8

This patch fixes Claude queue starvation and delayed child-event accounting, adds G2 agent-task details, removes generated context from G2 questions, preserves newer voice settings and supports user-owned Firebase sender projects. Final source checks and independent reviews passed.

Reviewed 2026-10-03:

| Check | Result |
| --- | --- |
| Windows source | 415 passed, 6 Linux-only tests skipped; type checking and production build passed |
| Linux source | 418 passed, 3 Windows-only tests skipped; type checking and production build passed |
| Windows desktop | Startup, autostart, scoped installer ownership and direct authenticated tray-update checks passed |
| Independent reviews | G2 projection/detail selection, voice persistence, Firebase validation and bounded Pi/Codex task metadata passed; Claude reordered-event, equal-time and recovery guards independently reviewed with 25/25 tests |
| NUC actual-data copy | 156 queued events drained; acknowledged legacy children no longer counted as confirmed active. Parent activity and conservative completion guards retained; no completion emitted. Live data and native processes were not modified |
| Production dependencies | npm audit reports zero known vulnerabilities; checked 2026-10-03 |

Runtime packages include only allowed production files and bundled dependencies. Packaging checks inventories, matching Windows/Linux frontend assets, credential exclusion and SHA-256 digests. Installer smoke checks use isolated installations and synthetic credentials, without model turns or real push delivery. Earlier detailed audit records are available in [the 1.1.7 source history](https://github.com/Liang-Chu/Even-Pilot/blob/a2844a8d04fad6c1e2128a361937cf6917d2bb1a/docs/release-status.md).

## Behavior and limits

- **Counts need lifecycle evidence.** Late Claude child events use independent timestamps. Conflicting events in the same millisecond retain uncertainty until a later authoritative event; they do not invent completion. Older unresolved state can show `?` until a fresh trusted parent Stop with an explicitly empty background registry confirms previously acknowledged children. Missing transcripts, custom Stop hooks, gaps and disconnected processes never imply success.
- **Agent-task descriptions depend on the tool.** Pi's optional official subagent extension supplies explicit task metadata, including outstanding queued workers. Ordinary Codex reports verified active child identities without inferring their tasks from copied history. Claude and other integrations may have no task description. Details are bounded to sixteen children and displayed as a snapshot while reading.
- **G2 still needs a physical-device acceptance pass.** Native lists own focus/scrolling; expanded text uses native scrolling. Automatic history refresh is deferred while browsing or editing. A message part stays under 900 UTF-8 bytes; larger messages use explicit part navigation because the public SDK has no scroll-position setter. Firmware controls list row spacing. Long-label acceptance and Bluetooth/ASR responsiveness cannot be established by mocks alone.
- **Claude support is experimental.** Its next prompt after hook activation establishes ordinary-terminal monitoring. Tests cover hooks, owner identity, background/cron blockers, restarts, custom-hook uncertainty and reordered events. Dynamically registered hooks and remote policies cannot be fully enumerated. Real model response, connector question answers and cancellation still need acceptance; a delivered Escape means Stop requested.
- **Ordinary Codex CLI/Desktop and Claude observation is read-only.** Remote prompts/control need a connector-backed session. Codex relies on local rollout files; cloud-only sessions are not covered and future CLI formats may require updates. G2 supports short single-question choices; multi-select and larger forms remain on phone/native terminals.
- **Platforms:** release installers target Windows 10/11 x64 and Linux x64/glibc. Windows binaries are unsigned. ARM64, Alpine/musl and Linux graphical desktops have not been physically validated.
- **Notifications:** configure a direct sender or one forwarding center and register Glance separately. No Firebase, connection or speech credentials are shipped. The session actually displayed on G2 suppresses its own completion notification while the viewing lease is valid.

Updating a companion retains its pairing and settings and leaves native CLI sessions running. Install the matching phone `.ehpk` separately. Watch, Unwatch, network loss and monitoring shutdown do not terminate native terminals.

See [setup](../README.md), [release notes](../RELEASE_NOTES.md), [connector limits](connectors.md) and [Glance setup](glance-push.md).
