# Terminal+ 1.1.15 — Hub release

- Phone and browser connect each computer immediately, then allow up to five automatic retries per startup/manual reconnect cycle, each 30 seconds after failure. Successes do not reset used retries; returning to the foreground does not reset or accelerate them. After exhaustion, use that computer's **Reconnect** under phone **Connection** / browser **Computers**, or start the app afresh. **Key rejected** (HTTP 401) stops retries; edit its credential. Watch is retained.
- Adds compact pixel-style **Status → All / Watched / Running** and **Devices** dropdowns. Select several computers; **All devices** or clearing the last selection shows every computer.
- Matches version 1.1.15 with the Windows/Linux companion browser portal for Pi, Codex and Claude. Existing Terminal+ Hub installations remain compatible; install this Hub package for the new phone reconnect and filter controls.
- Keeps **Terminal+**, app ID `local.terminalplus.app`, existing input/control capabilities and saved phone/voice settings. Saved phone connections do not synchronize to browsers; connect each browser once through **Computers → Connect another computer** with each target's own URL/key.
- Browser **Updates**, **Connect phone** and desktop **Glance notifications** remain tied to the computer serving the page.

Install `terminal-plus-1.1.15.ehpk` separately through Even Hub; companion updates do not install it. Physical phone/G2 acceptance remains unverified. See [release status](release-status.md) for validation and publication status.

# Terminal+ 1.1.13 — Hub release history

- Updates package version metadata to 1.1.13 with the existing UI. Large Claude transcript observation and retired-event recovery are companion fixes; existing Terminal+ Hub installations continue to work.
- Keeps **Terminal+**, app ID `local.terminalplus.app`, GPT Transcribe defaults and saved voice settings.

Upload `terminal-plus-1.1.13.ehpk` separately through Even Hub. Settings are retained within the same app identity. Moving from `local.evenpilot.app` may require a new listing/install; re-enter phone connections and voice keys if needed. Companion Watch and Glance settings remain on their existing backends.

Publish a Latest GitHub release only with its matching Windows/Linux installers and required digests; companion updates do not install the Hub package. See [release status](release-status.md) for checks and publication status.
