import type { FleetClient } from "../bridge/fleet.js";

interface UpdateStatus { currentVersion: string; automaticChecks: boolean; available?: { version: string; page: string }; phase: string;
  progress: number; error?: string; installSupported: boolean; checkedAt?: number; lastResult?: { status: string; version: string } }
/** Reads each paired backend; only those backends contact the release server. */
export class UpdateSettings {
  private dialog = document.createElement("dialog");
  private host: HTMLSelectElement;
  private automatic: HTMLInputElement;
  private message: HTMLParagraphElement;
  private check: HTMLButtonElement;
  private install: HTMLButtonElement;
  private latest?: UpdateStatus;
  private busy = false;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private client: () => FleetClient | undefined, private entry: HTMLButtonElement) {
    this.dialog.className = "update-settings";
    this.dialog.innerHTML = `<div class="dialog-heading"><h2>Updates</h2><button type="button" class="subtle" aria-label="Close updates">✕</button></div>
      <label>Computer<select aria-label="Computer to update"></select></label>
      <label class="update-option"><input type="checkbox">Automatically check for updates</label>
      <p class="caption">Checks once a day and shows new versions. Installation starts only when you choose Update. Turn off to disable background checks and reminders.</p>
      <p role="status"></p><div class="update-actions"><button type="button" class="outline">Check now</button><button type="button" class="primary" hidden>Update</button></div>`;
    this.host = this.dialog.querySelector("select")!; this.automatic = this.dialog.querySelector("input")!;
    this.message = this.dialog.querySelector('[role="status"]')!;
    this.check = this.dialog.querySelector(".outline")!; this.install = this.dialog.querySelector(".primary")!;
    this.dialog.querySelector<HTMLButtonElement>('[aria-label="Close updates"]')!.onclick = () => this.dialog.close();
    this.host.onchange = () => { this.latest = undefined; void this.load(); };
    this.check.onclick = () => { void this.act("/api/updates/check", {}); };
    this.automatic.onchange = () => { void this.act("/api/updates/settings", { automaticChecks: this.automatic.checked }); };
    this.install.onclick = () => {
      const version = this.latest?.available?.version;
      if (version) void this.act("/api/updates/install", { version });
    };
    this.dialog.addEventListener("close", () => { this.revision++; this.busy = false; this.schedule(60_000); });
    document.body.append(this.dialog); entry.onclick = () => this.open(); this.schedule(3000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.schedule(1000); });
  }
  open() {
    const hosts = this.client()?.hosts() || [];
    this.host.replaceChildren(...hosts.map(host => new Option(`${host.name}${host.online ? "" : " (offline)"}`, host.url)));
    this.host.value = this.client()?.activeUrl() || hosts[0]?.url || "";
    if (!this.dialog.open) this.dialog.showModal(); void this.load();
  }
  private lock(value: boolean) {
    this.busy = value; this.host.disabled = this.check.disabled = this.automatic.disabled = this.install.disabled = value;
  }
  private draw(status: UpdateStatus) {
    this.latest = status; this.automatic.checked = status.automaticChecks;
    const working = ["downloading", "installing"].includes(status.phase);
    this.message.textContent = working ? status.phase === "downloading" ? `Downloading ${status.progress}%…` : "Installing… The computer will reconnect."
      : [`Installed: ${status.currentVersion}`, status.available ? `Available: ${status.available.version}` : status.checkedAt && !status.error ? "No newer release." : "",
        status.error || "", status.lastResult?.status === "failed" ? "Last update failed; check the current version before retrying." : "",
        !status.installSupported ? "Source checkout: use the installer to enable in-app updates." : ""].filter(Boolean).join(" · ");
    this.install.hidden = !status.available || !status.installSupported;
    this.install.textContent = working ? "Updating…" : `Update to ${status.available?.version || ""}`;
    this.check.disabled = this.automatic.disabled = this.install.disabled = working;
  }
  private async load() {
    if (this.busy) return;
    const request = ++this.revision; this.lock(true); this.message.textContent = "Loading…";
    try {
      const status = await this.client()?.requestFrom(this.host.value, "/api/updates");
      if (request !== this.revision) return;
      this.lock(false); if (status) this.draw(status); else this.message.textContent = "Add a computer in Connection first.";
    } catch { if (request === this.revision) { this.lock(false); this.message.textContent = "Computer unavailable or backend needs an update."; this.install.hidden = true; } }
    this.schedule(this.dialog.open ? 3000 : 60_000);
  }
  private async act(path: string, body: object) {
    if (this.busy) return;
    const revision = ++this.revision, url = this.host.value; this.lock(true);
    try {
      const value = await this.client()?.requestFrom(url, path, body);
      if (revision !== this.revision) return;
      this.lock(false); if (value) this.draw(value);
    } catch (error) { if (revision === this.revision) { this.lock(false); this.message.textContent = error instanceof Error ? error.message : "Update request failed"; } }
    this.schedule(2000);
  }
  private schedule(ms: number) { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.poll(); }, ms); }
  private async poll() {
    if (document.hidden) { this.schedule(60_000); return; }
    if (this.dialog.open) { await this.load(); return; }
    const client = this.client();
    const found = await Promise.all((client?.hosts() || []).filter(host => host.online).map(async host => {
      try { const status = await client!.requestFrom(host.url!, "/api/updates") as UpdateStatus; return status.automaticChecks && status.available ? host.name : undefined; }
      catch { return; }
    }));
    const names = found.filter(Boolean);
    this.entry.textContent = names.length ? `Updates (${names.length})` : "Updates";
    this.entry.classList.toggle("updates-available", names.length > 0);
    this.entry.title = names.length ? `New version: ${names.join(", ")}` : "Versions and automatic update checks";
    this.schedule(60_000);
  }
}
