# Even-Pilot 1.1.6

Automatic updates are enabled by default on installed Windows/Linux companions.

- Companions check stable releases daily and automatically install verified updates. Existing opt-outs remain disabled; use **Automatic updates** on that computer or Linux `even-pilot update on|off` to change the preference.
- Automatic installation uses fresh release metadata, SHA-256 verification and the existing health check/rollback flow. A failed automatic attempt waits at least 24 hours before retrying the same version. **Check now** and `even-pilot update check` remain check-only; immediate manual installation is still available.
- Removed the companion updater from the phone Hub. Update each computer locally; install the Hub package separately.
- G2 assistant reply rows use a wider, preserved indent before the arrow. The native list still owns selection and scrolling.
- Headless companions recover finished or interrupted update jobs without needing a browser to poll their status. Linux `update status` also shows an earlier error without failing to print the remaining status.

Monitoring briefly restarts during installation. Native CLI sessions continue running, and pairing keys, Watch and notification settings are retained.

Install `even-pilot-1.1.6.ehpk` separately in Even Hub for the phone/G2 changes. Physical G2 spacing still needs device verification.
