import type { FleetClient } from "../bridge/fleet.js";

interface UpdateStatus { currentVersion: string; automaticChecks: boolean; available?: { version: string; page: string }; phase: string;
  progress: number; error?: string; installSupported: boolean; checkedAt?: number; lastResult?: { status: string; version: string } }
type UpdateClient = Pick<FleetClient, "hosts" | "requestFrom">;
/** Desktop updates always belong to the companion serving the page. */
export function updateComputer(client: UpdateClient | undefined, servingOrigin: string) {
  return client?.hosts().find(host => host.url === servingOrigin);
}
/** Reads only this page's companion; only the backend contacts the release server. */
export class UpdateSettings {
  private dialog = document.createElement("dialog");
  private computer: HTMLParagraphElement;
  private automatic: HTMLInputElement;
  private message: HTMLParagraphElement;
  private check: HTMLButtonElement;
  private install: HTMLButtonElement;
  private latest?: UpdateStatus;
  private busy = false;
  private reachable = false;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private client: () => UpdateClient | undefined, private entry: HTMLButtonElement, private servingOrigin: string,
    private notify?: (message: string) => void) {
    this.dialog.className = "update-settings";
    this.dialog.innerHTML = `<div class="dialog-heading"><h2>Updates</h2><button type="button" class="subtle" aria-label="Close updates">✕</button></div>
      <p class="caption" data-update-computer></p>
      <label class="update-option"><input type="checkbox">Automatic updates</label>
      <p class="caption">Checks daily and installs verified updates automatically. The monitor restarts; native terminals keep running. Turn off to disable automatic checks and installation.</p>
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
    this.revision++; this.busy = false; this.reachable = false; this.latest = undefined; this.install.hidden = true;
    this.computer.textContent = host ? `This computer: ${host.name}${host.online ? "" : " (offline)"}`
      : "Open this computer's Terminal+ desktop shortcut to connect.";
    if (!this.dialog.open) this.dialog.showModal(); void this.load();
  }
  private lock(value: boolean) {
    this.busy = value;
    this.check.disabled = this.automatic.disabled = this.install.disabled = value || !this.reachable
      || ["checking", "downloading", "installing"].includes(this.latest?.phase || "");
  }
  private draw(status: UpdateStatus) {
    this.latest = status; this.reachable = true; this.automatic.checked = status.automaticChecks;
    const working = ["downloading", "installing"].includes(status.phase);
    this.message.textContent = working ? status.phase === "downloading" ? `Downloading ${status.progress}%…` : "Installing… The computer will reconnect."
      : [`Installed: ${status.currentVersion}`, status.available ? `Available: ${status.available.version}` : status.checkedAt && !status.error ? "No newer release." : "",
        status.error || "", status.lastResult?.status === "failed" ? "Last update failed; check the current version before retrying." : "",
        !status.installSupported ? "Source checkout: use the installer to enable in-app updates." : ""].filter(Boolean).join(" · ");
    this.install.hidden = !status.available || !status.installSupported;
    this.install.textContent = working ? "Updating…" : `Update to ${status.available?.version || ""}`;
    this.lock(false);
    if (status.phase === "installing" && this.dialog.open) {
      const notice = "Installing update. This computer will restart; reconnect afterward.";
      this.entry.textContent = "Restarting…"; this.entry.title = notice; this.notify?.(notice);
      this.dialog.close();
    }
  }
  private async load() {
    if (this.busy) return;
    const client = this.client(), url = this.servingOrigin;
    if (!client || !url) {
      this.reachable = false; this.lock(false);
      this.message.textContent = "No computer connected for this page."; this.install.hidden = true;
      this.schedule(this.dialog.open ? 3000 : 60_000); return;
    }
    const request = ++this.revision; this.lock(true);
    if (!this.latest) this.message.textContent = "Loading…";
    try {
      const status = await client.requestFrom(url, "/api/updates");
      if (request !== this.revision) return;
      if (status) this.draw(status);
      else throw new Error("Update status unavailable");
    } catch { if (request === this.revision) { this.reachable = false; this.lock(false); this.message.textContent = "Reconnecting… Update status is unavailable."; } }
    if (request === this.revision) this.schedule(this.dialog.open ? 3000 : 60_000);
  }
  private async act(path: string, body: object) {
    if (this.busy || !this.reachable || ["checking", "downloading", "installing"].includes(this.latest?.phase || "")) return;
    const client = this.client(), url = this.servingOrigin;
    if (!client || !url) return;
    const revision = ++this.revision; this.lock(true);
    try {
      const value = await client.requestFrom(url, path, body);
      if (revision !== this.revision) return;
      if (value) this.draw(value);
      else throw new Error("Update response unavailable");
    } catch { if (revision === this.revision) { this.reachable = false; this.lock(false); this.message.textContent = "Reconnecting… Update request was not confirmed. Check status before trying again."; } }
    // Poll status only. A lost acknowledgement must never repeat installation.
    if (revision === this.revision) this.schedule(2000);
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
    this.entry.title = available ? `New version for ${host!.name}` : "Versions and automatic updates";
    this.schedule(60_000);
  }
}
