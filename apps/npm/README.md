# Terminal+ 1.1.16 for Linux

This guide covers **Terminal+ 1.1.16**. See [release status](https://github.com/Liang-Chu/Even-G2-Terminal-plus/blob/main/docs/release-status.md) for verification and publication details.

Install the Linux companion to watch local Pi, Codex and Claude Code sessions through a browser, Even Hub on your phone and Even G2. Continue using your native terminal, with optional voice input and per-session completion notifications through Glance.

Requires Linux **x64/glibc**, Node **22+** and npm for this installation method. Run as the same ordinary user who runs your CLI, without `sudo`.

## Install

```sh
npm install -g terminal-plus
terminal-plus-setup
```

Open a new shell, then run:

```sh
terminal-plus
terminal-plus pair
```

The setup helper works even when npm skips install scripts. It installs the bundled, verified companion under `~/.local/lib/even-pilot` and its normal command at `~/.local/bin/terminal-plus`. The installation directory stays stable so upgrades reuse existing settings and services. In the current shell, use that full launcher path. The separate `terminal-plus-setup` command keeps npm from replacing the companion's launcher.

If npm reports `EACCES`, use a user-owned prefix instead of `sudo`:

```sh
npm install -g --prefix "$HOME/.local" terminal-plus
~/.local/bin/terminal-plus-setup
```

First installation deploys files without starting monitoring; `terminal-plus` starts it. Existing older installations are upgraded and restarted; equal or newer versions are retained. Your native CLI login, terminal processes and saved settings remain in place. The companion includes its own Node runtime and backend dependencies.

## Connect and use

Install the matching Even Hub package from [GitHub Releases](https://github.com/Liang-Chu/Even-G2-Terminal-plus/releases). For internet access, keep the phone and computers connected to the same Tailscale network. Enter one known computer's URL/key from `terminal-plus pair` or Windows **Connect phone** in the phone app's **Connection** settings. Its shared computer list loads automatically. Add a new computer once from any paired viewer; open viewers synchronize the list through reachable companions. Pair only computers/viewers you trust to access the whole list, including its connection keys. Sessions still load directly from their source.

Use `terminal-plus sessions`, `watch SESSION`, `unwatch SESSION` and `settings` for session and notification management. Unwatch does not stop a terminal. Run `terminal-plus --help` for commands.

For optional voice input, save your own transcription API key in the phone's **Voice** settings. New or model-less OpenAI configurations default to **GPT Transcribe** with streamed text; existing provider, keys and explicit Whisper choices are retained.

[Step-by-step setup, CLI integration and controls](https://github.com/Liang-Chu/Even-G2-Terminal-plus#readme) · [Glance notifications](https://github.com/Liang-Chu/Glance)

## Update and remove

The companion automatically installs verified stable GitHub updates by default. Use `terminal-plus update off` to disable, `update on` to enable, or `update` to install now. You do not need `npm update`; rerunning setup will not downgrade a newer companion. Update all companions and install Hub 1.1.16 separately for shared connections. Open the updated phone/browser with your existing list once to publish verified entries; unverified offline entries stay local until verified. Older clients keep local-only lists. Voice, Firebase and model credentials are not shared.

Close terminals that still use installation files, then remove the companion and its npm helper:

```sh
terminal-plus uninstall
npm uninstall -g terminal-plus
```

Saved connection, Watch and notification settings are retained. Removing only the npm package does not remove the companion.
