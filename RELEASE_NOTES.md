# Even-Pilot 1.1.2

A patch for clearer connection setup and reliable Windows update checks.

- Desktop **Connection** shows this computer's phone URL, key and QR directly. **Other computers** adds remote sessions to the viewer; connection editing is shown only when needed.
- **Glance** settings separate each source computer's direct delivery from forwarding through a chosen center. Saved viewing connections and notification routes have distinct controls.
- Windows update requests handle an address-family resolution problem while preserving certificate validation, verified downloads and cancellation.
- Rejected connection keys identify the affected computer. Failed update staging releases the download and remains retryable.
- Claude question text/options refresh in ordinary monitored history. Explicit connector sessions support remote single-choice/free-text answers; G2 uses native options and an **Other** input row. Multi-select stays native; real Claude/G2 acceptance remains pending.
- Short bilingual quickstarts, complete setup guides and an operator/agent runbook cover installation, existing CLI monitoring, pairing, Watch, direct/central push and updates.

Includes 1.1.1's **New prompt** and selected-session activity row on G2, plus direct tray update progress.

Update the Windows/Linux companion, then upload/install `even-pilot-1.1.2.ehpk` separately in Even Hub. Companion updates do not update the phone package. Existing pairing, Watch and notification settings are retained; native terminals remain running.

Read-only Codex/Claude sessions still require a connector for remote input. Existing platform, Claude and physical-device limitations remain; see [setup](https://github.com/Liang-Chu/Even-Pilot#readme).
