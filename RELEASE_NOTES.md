# Even-Pilot 1.1.4

Fixes companion restarts during updates and simplifies phone connection setup.

- Windows updates retire the old tray before stopping the monitor, preventing it from starting the previous backend during installation.
- Shutdown closes stalled HTTP connections after a short drain so the replacement monitor can acquire its lock. Native CLI sessions keep running.
- Updates announce the restart and close the settings dialog. Download progress stays visible, and a lost acknowledgement never repeats the installation request.
- **Connect phone** shows this computer's URL, connection key, matching copy buttons and shared QR in one compact panel. Existing connection keys are retained during updates.
- G2 agent replies have two spaces before their arrow to distinguish them from user messages.

Install `even-pilot-1.1.4.ehpk` separately in Even Hub for the UI changes. Updating the Windows/Linux companion does not replace the phone package. Physical G2 rendering still requires device verification.
