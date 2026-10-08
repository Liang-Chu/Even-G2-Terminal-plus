# Unreleased

- New and model-less OpenAI voice configurations default to **GPT Transcribe**, with streamed text. Existing explicit Whisper choices, providers and API keys remain saved. Voice settings show Whisper's 2027-02-26 retirement date when selected. Published 1.1.11 already supports switching to GPT Transcribe manually.

# Terminal+ 1.1.11

Unifies the Windows/Linux companion and phone/G2 app under **Terminal+**.

- Windows shortcuts, tray, manager and installer use Terminal+. Executables and release assets use `Terminal-plus`.
- Linux uses the `terminal-plus` command and the npm setup helper uses `terminal-plus-setup`. The old native command remains a compatibility alias.
- Public source, downloads and future update checks use [Even-G2-Terminal-plus](https://github.com/Liang-Chu/Even-G2-Terminal-plus).
- The companion and Hub package share version **1.1.11**. Hub keeps the Terminal+ package ID `local.terminalplus.app`.

**Existing Even-Pilot installations need one manual upgrade:** run the new Windows EXE or Linux `.run` installer. The repository rename may prevent older updaters from completing this upgrade. Existing installation/data/service roots, `EVEN_PILOT_*` configuration and integration identifiers remain compatible to preserve connection keys, Watch and notification settings. Native CLI sessions keep running.

Install `terminal-plus-1.1.11.ehpk` separately in Even Hub. Moving from `local.evenpilot.app` may require a fresh listing/install; re-enter phone connections and voice keys if needed.

See [release status](docs/release-status.md) for verified checks and remaining physical phone/G2 acceptance. Claude support remains experimental.
