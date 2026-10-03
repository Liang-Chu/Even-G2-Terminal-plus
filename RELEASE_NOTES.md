# Even-Pilot 1.1.7

Fixes device-name recovery and missing Codex prompts after large tool output.

- The phone/desktop retries device-name lookup even when a session is idle. Temporary lookup failures keep the last verified Tailscale name; disconnected or removed devices stop retrying.
- Unchanged device-name polls do not refresh the display or add Bluetooth writes.
- Codex startup history now retains conversation messages encountered by its existing lifecycle backscan. Large tool-output gaps no longer discard those earlier prompts and replies. The fix adds no whole-history scan and does not replay old completion notifications.
- Current Codex user-input events distinguish your prompts from CLI context and instructions. Repeated records and rereading a truncated file no longer duplicate retained prompts.

Native CLI sessions keep running during companion updates; pairing keys, Watch and notification settings are retained. Automatic updates remain enabled by default, with existing opt-outs respected.

Install `even-pilot-1.1.7.ehpk` separately in Even Hub for the device-name retry fix. Existing saved connections remain valid. Recent-history limits and ordinary Codex's read-only monitoring still apply.
