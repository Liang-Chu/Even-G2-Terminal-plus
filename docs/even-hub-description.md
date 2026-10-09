# Even Hub description — Terminal+ 1.1.16

View coding sessions running on Windows/Linux through your phone and G2 while you keep working in your terminal.

- Monitor Pi, Codex CLI/local Codex Desktop and Claude Code across Windows and Linux computers.
- Add a computer once; paired phones and browser portals share the list. A new viewer connects one known computer to get started.
- Filter All/Watched/Running sessions and select several computers.
- Retry offline computers up to five times at 30-second intervals, then reconnect manually. Disconnections retain Watch.
- See reported running-agent counts, running/idle time, source computer and model, plus available agent task details.
- Switch watched sessions and expand the latest ten messages using native G2 lists and scrolling.
- Build voice prompts sentence by sentence: record, stop, add another, delete the latest segment, then review and send.
- Watch/Unwatch without stopping terminals or tasks.
- Receive per-session completion push on your phone and G2 via Glance, with independent senders or one central server.

For internet access, connect the phone and computers through Tailscale. Each session source must be reachable directly. Paired computers share connection keys; only pair trusted devices. The list synchronizes while a viewer is open.

Voice recognition requires your own OpenAI API key or ElevenLabs key; a ChatGPT subscription alone is insufficient. OpenAI defaults to GPT Transcribe with streamed text; explicitly saved model choices remain.

Phone/voice replies require an input-capable session. Ordinary Codex/Claude sessions are read-only; Claude support is experimental.

Shared connections require matching 1.1.16 companions.

Required Windows/Linux companion and setup:
[Terminal+](https://github.com/Liang-Chu/Even-G2-Terminal-plus)

Optional notification app and setup:
[Glance](https://github.com/Liang-Chu/Glance)
