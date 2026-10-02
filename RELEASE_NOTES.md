# Even-Pilot 1.1.0

Even-Pilot monitors Pi, Codex and Claude Code sessions on Windows and Linux, with a shared phone/Even G2 interface and support for multiple computers.

- Linux CLI focuses on connections, session management, Watch and settings. Removed CLI prompt sending, task interruption and the terminal wrapper; phone/G2 input remains available for supported sessions.
- Linux installation registers `even-pilot` for supported user shells. Notification routing and Firebase sender setup can be configured over SSH.
- Ordinary Claude terminals now use official monitor hooks for read-only status and completion notifications, without a Channel. Unrelated Claude settings survive installation, rollback and uninstall.
- Fixed false Codex Desktop completion notifications when a child rollout contained copied parent metadata. Claude completion also waits for reported child/background work and remains unconfirmed when known custom Stop hooks may continue the turn.
- Reliable daily update checks with a disable switch, explicit verified installation, startup validation and rollback. Recover from an interrupted update worker; Windows launcher checks now wait for the installed child and return its result.
- Updates targets the computer serving the desktop page, or the active computer in Hub; removed the extra computer selector.
- Monitoring continues through temporary settings/journal write failures, with durable completion delivery after recovery. Dead terminal snapshots are cleaned gradually without touching CLI histories or active terminals.
- Manual Unwatch stays off across later native tasks and reconnects; it never closes or interrupts the CLI.
- G2 uses native lists and text scrolling, bounded recent history and cached status tiles. Phone sessions are grouped by computer and tool records fold by default.
- Optional Glance push supports direct delivery or a central sender. Linux pairing prints a QR code for Glance.

Install the matching Windows EXE or Linux x64 `.run`, then upload `even-pilot-1.1.0.ehpk` to Even Hub. Existing keys, Watch and notification settings are retained; native terminals keep running during monitoring updates.

Known limitations: Claude is experimental; ordinary Codex CLI/Desktop and Claude monitoring is read-only. Claude's next prompt establishes observation after hook setup; dynamically registered Stop hooks remain a limitation. G2 gestures, Bluetooth responsiveness and live voice/central push still need acceptance with this version. Windows binaries are unsigned; Linux binaries require x64/glibc. Setup and downloads: https://github.com/Liang-Chu/Even-Pilot
