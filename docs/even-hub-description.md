# Even Hub description — Terminal+ 1.1.10

Terminal+ lets you view coding sessions running on Windows/Linux through Even Hub and Even G2 while you keep working in your normal terminal.

- Monitor Pi, Codex CLI/local Codex Desktop and Claude Code across Windows and Linux computers.
- See reported running-agent counts, running/idle time, source computer and model, plus available agent task details.
- Switch watched sessions and expand the latest ten messages using native G2 lists and scrolling.
- Build voice prompts sentence by sentence: record, stop, add another sentence, delete the latest segment, then review and send.
- Manage Watch/Unwatch without stopping terminals or tasks. Temporary disconnections retain Watch.
- Receive per-session completion push notifications on your phone and G2 via Glance. Configure independent senders or forward through one central server.

For internet access to your computers, connect the phone and computers through Tailscale. Voice recognition requires your own OpenAI API key (Whisper or GPT Transcribe), or an ElevenLabs key; a ChatGPT subscription alone is insufficient.

Phone/voice replies require an input-capable session. Ordinary Codex/Claude sessions are read-only; Claude support is experimental.

Moving from an earlier Hub app may require connecting your computers and setting up Voice again.

Required Windows/Linux companion and setup:
[Even-Pilot](https://github.com/Liang-Chu/Even-Pilot)

Optional notification app and setup:
[Glance](https://github.com/Liang-Chu/Glance)
