# Terminal+ 1.1.13

- Keeps active Claude sessions visible when their native transcript exceeds the former 32 MiB whole-file limit. Reads a bounded 64 KiB head and 2 MiB tail instead of scanning the entire history.
- Discards definitely retired events whose first prompt cannot be recovered, allowing current Claude events to progress through a blocked queue. Missing history or uncertain/live events do not imply completion.

Update the Windows/Linux companion to 1.1.13. Existing Terminal+ Hub installations continue to work; this Claude monitoring fix does not require a phone/G2 update. Existing settings and native CLI processes are retained. See [release status](https://github.com/Liang-Chu/Even-G2-Terminal-plus/blob/v1.1.13/docs/release-status.md) for verification and publication status.

# Terminal+ 1.1.12 — history

- New and model-less OpenAI voice configurations default to **GPT Transcribe**, with streamed text.
- Existing explicit Whisper choices, providers and API keys remain saved.
- Voice settings show Whisper's 2027-02-26 retirement date when selected.

Install the Windows/Linux 1.1.12 companion and `terminal-plus-1.1.12.ehpk` separately. Hub keeps `local.terminalplus.app`, retaining existing phone settings within that app identity. See [release status](https://github.com/Liang-Chu/Even-G2-Terminal-plus/blob/v1.1.12/docs/release-status.md) for verified checks and remaining physical phone/G2 acceptance.

# Terminal+ 1.1.11 — history

Unifies the Windows/Linux companion and phone/G2 app under **Terminal+**.

- Windows shortcuts, tray, manager and installer use Terminal+. Executables and release assets use `Terminal-plus`.
- Linux uses the `terminal-plus` command and the npm setup helper uses `terminal-plus-setup`. The old native command remains a compatibility alias.
- Public source, downloads and future update checks use [Even-G2-Terminal-plus](https://github.com/Liang-Chu/Even-G2-Terminal-plus).
- The companion and Hub package share version **1.1.11**. Hub keeps the Terminal+ package ID `local.terminalplus.app`.

**Existing Even-Pilot installations need one manual upgrade:** run the new Windows EXE or Linux `.run` installer. The repository rename may prevent older updaters from completing this upgrade. Existing installation/data/service roots, `EVEN_PILOT_*` configuration and integration identifiers remain compatible to preserve connection keys, Watch and notification settings. Native CLI sessions keep running.

Install `terminal-plus-1.1.11.ehpk` separately in Even Hub. Moving from `local.evenpilot.app` may require a fresh listing/install; re-enter phone connections and voice keys if needed.

See [release status](docs/release-status.md) for verified checks and remaining physical phone/G2 acceptance. Claude support remains experimental.
