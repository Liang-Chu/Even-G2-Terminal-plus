# Even Hub description — Even-Pilot 1.1.4

Even-Pilot brings your coding sessions to Even G2. Monitor Pi, Codex and Claude Code sessions across multiple computers, see the source computer, model, agent count and running status, and switch between watched sessions.

Read the latest ten messages in a native list, with New prompt at the top and the selected session's active-agent count directly underneath while working. Tap to expand a message, and use voice input to reply to supported sessions. Complete output stays in your original terminal. Manage Watch on your phone or computer; Unwatch does not stop the session. Optional Glance notifications report completion, with one sender per computer or a central forwarding server.

**Requires the free Even-Pilot companion on Windows 10/11 x64 or Linux x64/glibc.** Download it and follow setup here:

https://github.com/Liang-Chu/Even-Pilot/releases

https://github.com/Liang-Chu/Even-Pilot#readme

Connect your phone and computer through Tailscale or a reachable local network. On the phone open Connection, expand Connect another computer, enter that computer's Bridge URL and Connection key, then Connect computer. Saved computers appear together in Sessions. CLI model login stays with your existing CLI. Voice transcription is optional and requires your own OpenAI or ElevenLabs API key.

Companion updates do not update this phone app. Install the matching Even Hub package separately to receive G2 changes.

Known limitations: ordinary Codex CLI/Desktop and Claude Code sessions support observation and completion notifications; remote reply/control requires a connector session. The companion installs Claude's official monitor hooks; its next prompt establishes monitoring. Custom Stop hooks can leave completion unconfirmed, and Claude support remains experimental. G2 behavior can vary with firmware; Windows binaries are unsigned. See the setup guide for the current requirements and limitations.
