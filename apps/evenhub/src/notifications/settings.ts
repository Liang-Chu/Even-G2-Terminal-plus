import type { FleetClient } from "../bridge/fleet.js";

export class NotificationSettings {
  private dialog = document.createElement("dialog");
  private source: HTMLSelectElement;
  private delivery: HTMLSelectElement;
  private status: HTMLParagraphElement;
  private sources: HTMLDivElement;
  private save: HTMLButtonElement;
  private revision = 0;
  private busy = false;
  constructor(private client: () => FleetClient | undefined) {
    this.dialog.className = "notification-settings";
    this.dialog.innerHTML = `<div class="dialog-heading"><h2>Notifications</h2><button type="button" class="subtle" aria-label="Close notifications">✕</button></div>
      <p class="caption">Send from each computer, or forward completion events to one center. The center needs FCM credentials and a Glance PUSH watcher.</p>
      <label>Computer<select aria-label="Notification source computer"></select></label>
      <label>Delivery<select aria-label="Notification delivery"></select></label>
      <p class="caption" role="status"></p><div class="relay-sources"></div>
      <button type="button" class="primary">Save notification route</button>`;
    this.source = this.dialog.querySelectorAll("select")[0]; this.delivery = this.dialog.querySelectorAll("select")[1];
    this.status = this.dialog.querySelector('[role="status"]')!; this.sources = this.dialog.querySelector(".relay-sources")!;
    this.save = this.dialog.querySelector(".primary")!;
    this.dialog.querySelector<HTMLButtonElement>('[aria-label="Close notifications"]')!.onclick = () => this.dialog.close();
    this.source.onchange = () => { void this.load(); }; this.save.onclick = () => { void this.configure(); };
    this.dialog.addEventListener("close", () => { this.revision++; }); document.body.append(this.dialog);
  }
  open() {
    const client = this.client(), hosts = client?.hosts() || [];
    this.source.replaceChildren(...hosts.map(host => new Option(`${host.name}${host.online ? "" : " (offline)"}`, host.url)));
    this.source.value = client?.activeUrl() || hosts[0]?.url || "";
    if (!this.dialog.open) this.dialog.showModal(); void this.load();
  }
  private lock(value: boolean) { this.busy = value; this.source.disabled = this.delivery.disabled = this.save.disabled = value; }
  private async load() {
    const client = this.client(), url = this.source.value, request = ++this.revision;
    this.delivery.replaceChildren(new Option("Send directly from this computer", "direct"));
    for (const host of client?.hosts() || []) if (host.url !== url && host.online) this.delivery.append(new Option(`Forward via ${host.name}`, host.url));
    this.sources.replaceChildren(); this.status.textContent = "Loading notification settings…";
    this.save.disabled = true;
    if (!client || !url) { this.status.textContent = "Add a computer in Connection first."; return; }
    try {
      const [routing, push] = await Promise.all([client.requestFrom(url, "/api/glance/routing"), client.requestFrom(url, "/api/glance/push")]);
      if (request !== this.revision) return;
      if (routing.target && ![...this.delivery.options].some(option => option.value === routing.target.url))
        this.delivery.append(new Option(`Forward via ${routing.target.name} (saved)`, routing.target.url));
      this.delivery.value = routing.target?.url || "direct";
      this.status.textContent = routing.mode === "relay" ? `Via ${routing.target.name} · ${routing.queued} queued · ${routing.lastResult || "Ready"}`
        : `${routing.senderConfigured ? "FCM configured" : "FCM not configured"} · ${push.subscriptions.length} Glance watcher(s).`;
      for (const peer of routing.sources) {
        const row = document.createElement("p"), name = document.createElement("span"), remove = document.createElement("button");
        name.textContent = `Receiving from ${peer.name} `; remove.type = "button"; remove.className = "text-button"; remove.textContent = "Disconnect";
        remove.onclick = async () => {
          if (this.busy) return; this.lock(true);
          try { await client.requestFrom(url, "/api/glance/relay/revoke", { sourceId: peer.id }); await this.load(); }
          catch { this.status.textContent = "Could not disconnect this relay source."; } finally { this.lock(false); }
        };
        row.append(name, remove); this.sources.append(row);
      }
      this.save.disabled = false;
    } catch (error) {
      if (request === this.revision) this.status.textContent = `Could not load routing. Update this backend to 1.0.21. ${error instanceof Error ? error.message : ""}`;
    }
  }
  private async configure() {
    if (this.busy) return;
    const client = this.client(), url = this.source.value, targetUrl = this.delivery.value;
    if (!client || !url) return;
    this.lock(true); this.status.textContent = "Saving…";
    try {
      if (targetUrl === "direct") await client.requestFrom(url, "/api/glance/routing", { mode: "direct" });
      else {
        const source = await client.requestFrom(url, "/api/host");
        const peer = await client.requestFrom(targetUrl, "/api/glance/relay/register", { sourceId: source.id, sourceName: source.name });
        await client.requestFrom(url, "/api/glance/routing", { mode: "relay", target: { ...peer, url: targetUrl } });
      }
      await this.load();
    } catch (error) { this.status.textContent = error instanceof Error ? error.message : "Could not save notification route"; }
    finally { this.lock(false); }
  }
}
