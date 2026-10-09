# Terminal+ 1.1.17 — Hub update

- Shows **Needs input** for the selected session. **Answer →** opens supported structured questions/approvals on the phone; native-only requests say **Answer in original terminal**.
- Keeps short single-question/options on the native G2 list; oversized or multiple supported forms move to the phone. Unsupported formats stay in the native terminal.
- Works with companion input/approval notifications through existing direct or relay Glance watchers. No re-registration is required; G2 viewing suppresses completion, while input-needed alerts remain allowed.
- Detection-only coverage includes Pi native dialogs, recognized ordinary Codex question records and Claude hooks. Ordinary Codex approvals and arbitrary shell/CLI prompts are not supported.

Install `terminal-plus-1.1.17.ehpk` separately and update companions. Existing Pi needs `/reload` while idle; reopen connector terminals while idle to load embedded changes, without interrupting user tasks. Physical phone/G2 acceptance is not established. See [release status](release-status.md).

# Terminal+ 1.1.16 — Hub release candidate history

- Shares computer connections with the matching Windows/Linux companions. Pair one known computer on a new phone/browser to load the shared list; add another computer once from any paired viewer.
- Migrates identity-verified connections from existing phone/browser storage. Unverified offline entries stay local until verified; removing a connection synchronizes without changing Watch or stopping terminals.
- While open, the phone/browser exchanges lists with reachable paired companions. Sources still need direct Tailscale/LAN access; paired computers share connection keys, not voice, Firebase or model credentials.
- Keeps the 1.1.15 reconnect policy, compact Status/Devices filters, native G2 controls and app ID `local.terminalplus.app`. Older clients still connect but do not share their local lists.

Install `terminal-plus-1.1.16.ehpk` separately through Even Hub and update companions to 1.1.16. For an existing phone list, open the updated Hub app once to seed reachable companions. This source candidate is not a publication or physical phone/G2 acceptance claim; see [release status](release-status.md).

# Terminal+ 1.1.15 — Hub release history

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
