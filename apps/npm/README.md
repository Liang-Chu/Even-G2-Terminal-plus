# Even-Pilot for Linux

Install the Linux companion to watch local Pi, Codex and Claude Code sessions through Even Hub on your phone and Even G2. Continue using your native terminal, with optional voice input and per-session completion notifications through Glance.

Requires Linux **x64/glibc**, Node **22+** and npm for this installation method. Run as the same ordinary user who runs your CLI, without `sudo`.

## Install

```sh
npm install -g even-pilot
even-pilot-setup
```

Open a new shell, then run:

```sh
even-pilot
even-pilot pair
```

The setup helper works even when npm skips install scripts. It installs the bundled, verified companion under `~/.local/lib/even-pilot` and its normal command at `~/.local/bin/even-pilot`. In the current shell, use that full path. The separate `even-pilot-setup` command keeps npm from replacing the companion's launcher.

If npm reports `EACCES`, use a user-owned prefix instead of `sudo`:

```sh
npm install -g --prefix "$HOME/.local" even-pilot
~/.local/bin/even-pilot-setup
```

First installation deploys files without starting monitoring; `even-pilot` starts it. Existing older installations are upgraded and restarted; equal or newer versions are retained. Your native CLI login, terminal processes and saved settings remain in place. The companion includes its own Node runtime and backend dependencies.

## Connect and use

Install the matching Even Hub package from [GitHub Releases](https://github.com/Liang-Chu/Even-Pilot/releases). For internet access, keep the phone and computers connected to the same Tailscale network. Enter the URL and connection key printed by `even-pilot pair` in the phone app's **Connection** settings.

Use `even-pilot sessions`, `watch SESSION`, `unwatch SESSION` and `settings` for session and notification management. Unwatch does not stop a terminal. Run `even-pilot --help` for commands.

[Step-by-step setup, CLI integration and controls](https://github.com/Liang-Chu/Even-Pilot#readme) · [Glance notifications](https://github.com/Liang-Chu/Glance)

## Update and remove

The companion automatically installs verified stable GitHub updates by default. Use `even-pilot update off` to disable, `update on` to enable, or `update` to install now. You do not need `npm update`; rerunning setup will not downgrade a newer companion. Update the phone's Hub package separately.

Close terminals that still use installation files, then remove the companion and its npm helper:

```sh
even-pilot uninstall
npm uninstall -g even-pilot
```

Saved connection, Watch and notification settings are retained. Removing only the npm package does not remove the companion.
