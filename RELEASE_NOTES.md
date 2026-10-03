# Even-Pilot 1.1.8

Fixes accumulated Claude agent counts and removes generated context from G2 questions.

- Missing transcripts from other Claude sessions no longer block valid completion events. Independent child timestamps handle delayed stops without clearing a restarted agent or sending a false completion notification.
- Select the running-agent row on G2 to open task details. Pi exposes explicit subagent tasks; Codex exposes verified child identities. Missing descriptions and uncertain counts are shown honestly.
- Expanded G2 questions show your actual request, without recognized Codex browser/attachment metadata or a missing-summary notice. Original CLI histories stay intact.
- Voice settings retain the newest saved keys across delayed native storage operations and reconnects.
- Glance senders accept your own Firebase project and reject registrations for a different project. Removed unused Hub UI and shortened the documentation.

Update the Windows/Linux companion and install `even-pilot-1.1.8.ehpk` separately in Even Hub. Existing connections, Watch, voice and notification settings are retained; native CLI sessions keep running.

Older unresolved Claude state may show `?` until a fresh trusted parent completion confirms that its acknowledged children have finished. Claude remains experimental; physical G2 acceptance of the new detail view is pending.
