import type { FleetClient } from "../bridge/fleet.js";

interface UpdateStatus { currentVersion: string; automaticChecks: boolean; available?: { version: string; page: string }; phase: string;
  progress: number; error?: string; installSupported: boolean; checkedAt?: number; lastResult?: { status: string; version: string } }
type UpdateClient = Pick<FleetClient, "activeUrl" | "hosts" | "requestFrom">;
/** Desktop updates always belong to the companion serving the page. */
export function updateComputer(client: UpdateClient | undefined, servingOrigin?: string) {
  const url = servingOrigin || client?.activeUrl();
  return client?.hosts().find(host => host.url === url);
}
/** Reads only this page's companion; only the backend contacts the release server. */
export class UpdateSettings {
  private dialog = document.createElement("dialog");
  private computer: HTMLParagraphElement;
  private targetUrl?: string;
  private automatic: HTMLInputElement;
  private message: HTMLParagraphElement;
  private check: HTMLButtonElement;
  private install: HTMLButtonElement;
  private latest?: UpdateStatus;
  private busy = false;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private client: () => UpdateClient | undefined, private entry: HTMLButtonElement, private servingOrigin?: string) {
    this.dialog.className = "update-settings";
    this.dialog.innerHTML = `<div class="dialog-heading"><h2>Updates</h2><button type="button" class="subtle" aria-label="Close updates">✕</button></div>
      <p class="caption" data-update-computer></p>
      <label class="update-option"><input type="checkbox">Automatically check for updates</label>
      <p class="caption">Checks once a day and shows new versions. Installation starts only when you choose Update. Turn off to disable background checks and reminders.</p>
      <p role="status"></p><div class="update-actions"><button type="button" class="outline">Check now</button><button type="button" class="primary" hidden>Update</button></div>`;
    this.computer = this.dialog.querySelector("[data-update-computer]")!; this.automatic = this.dialog.querySelector("input")!;
    this.message = this.dialog.querySelector('[role="status"]')!;
    this.check = this.dialog.querySelector(".outline")!; this.install = this.dialog.querySelector(".primary")!;
    this.dialog.querySelector<HTMLButtonElement>('[aria-label="Close updates"]')!.onclick = () => this.dialog.close();
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
    const host = updateComputer(this.client(), this.servingOrigin);
    this.revision++; this.busy = false; this.latest = undefined; this.install.hidden = true;
    this.targetUrl = this.servingOrigin || host?.url;
    this.computer.textContent = host ? `${this.servingOrigin ? "This computer" : "Computer"}: ${host.name}${host.online ? "" : " (offline)"}`
      : this.servingOrigin ? "Connect this computer in Connection first." : "Choose a connected computer in Sessions first.";
    if (!this.dialog.open) this.dialog.showModal(); void this.load();
  }
  private lock(value: boolean) {
    this.busy = value; this.check.disabled = this.automatic.disabled = this.install.disabled = value;
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
    const client = this.client(), url = this.targetUrl;
    if (!client || !url) {
      this.lock(false); this.check.disabled = this.automatic.disabled = this.install.disabled = true;
      this.message.textContent = "No computer connected for this page."; this.install.hidden = true;
      this.schedule(this.dialog.open ? 3000 : 60_000); return;
    }
    const request = ++this.revision; this.lock(true); this.message.textContent = "Loading…";
    try {
      const status = await client.requestFrom(url, "/api/updates");
      if (request !== this.revision) return;
      this.lock(false); if (status) this.draw(status);
    } catch { if (request === this.revision) { this.lock(false); this.message.textContent = "Computer unavailable or backend needs an update."; this.install.hidden = true; } }
    this.schedule(this.dialog.open ? 3000 : 60_000);
  }
  private async act(path: string, body: object) {
    if (this.busy) return;
    const client = this.client(), url = this.targetUrl;
    if (!client || !url) return;
    const revision = ++this.revision; this.lock(true);
    try {
      const value = await client.requestFrom(url, path, body);
      if (revision !== this.revision) return;
      this.lock(false); if (value) this.draw(value);
    } catch (error) { if (revision === this.revision) { this.lock(false); this.message.textContent = error instanceof Error ? error.message : "Update request failed"; } }
    this.schedule(2000);
  }
  private schedule(ms: number) { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.poll(); }, ms); }
  private async poll() {
    if (document.hidden) { this.schedule(60_000); return; }
    if (this.dialog.open) { await this.load(); return; }
    const client = this.client(), host = updateComputer(client, this.servingOrigin);
    let available = false;
    if (client && host?.online && host.url) {
      try { const status = await client.requestFrom(host.url, "/api/updates") as UpdateStatus; available = !!(status.automaticChecks && status.available); }
      catch { /* The same computer may be restarting; never probe another computer instead. */ }
    }
    this.entry.textContent = available ? "Update available" : "Updates";
    this.entry.classList.toggle("updates-available", available);
    this.entry.title = available ? `New version for ${host!.name}` : "Versions and automatic update checks";
    this.schedule(60_000);
  }
}
