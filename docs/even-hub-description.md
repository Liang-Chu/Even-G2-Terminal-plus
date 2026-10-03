# Even Hub description — Even-Pilot 1.1.8

Even-Pilot is a lightweight watcher for your native Pi, Codex and Claude Code sessions. On Even G2, see the computer, model, agent count and running status; switch watched sessions and expand the latest ten messages from a native list. Your phone combines sessions from multiple computers. Unwatch never stops a terminal or task.

**Requires the free companion on Windows 10/11 x64 or Linux x64/glibc, plus Even App 2.2.10+.** Existing CLI installations and model logins stay with your CLI.

[Download companions](https://github.com/Liang-Chu/Even-Pilot/releases) · [Repository and full setup](https://github.com/Liang-Chu/Even-Pilot#readme)

1. Install the companion on each computer as the same user who runs the CLI. On Linux, run the downloaded `.run` installer with `sh`.
2. Connect phone and computer to the same Tailscale network. Keep the companion running and the computer awake.
3. Install this Hub app. Get the computer's URL/key from Windows **Connect phone** or Linux `even-pilot pair`. In phone **Connection → Connect another computer**, paste **Bridge URL** and **Connection key**, then choose **Connect computer**. Details save automatically; repeat for other computers.
4. In **Sessions**, enable **Watch**, then open Even-Pilot on G2. Existing Pi needs `/reload` while idle; Claude monitoring begins with its next prompt. The repository guide covers setup and troubleshooting.

Voice replies are optional and require your own OpenAI or ElevenLabs transcription key in **Voice**. Ordinary Codex CLI/Desktop and Claude sessions are read-only; remote replies require a connector session. Claude support remains experimental. Complete output stays in your original terminal.

Optional Android completion notifications use [Glance](https://github.com/Liang-Chu/Glance#readme). For direct delivery, configure each sender; for central delivery, configure one center and forward other computers through **Glance notifications**. In Glance, scan the sender/center's **Connect phone** QR (Linux `even-pilot pair`), choose **SAVE AND REGISTER**, then enable Glance in Even App **Notifications**; its README covers installation and importing your own Firebase project.
