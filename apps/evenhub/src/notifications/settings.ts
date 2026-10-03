import type { FleetClient } from "../bridge/fleet.js";

/** Opening this dialog only reads each computer's existing notification route. */
export class NotificationSettings {
  private dialog = document.createElement("dialog");
  private source: HTMLSelectElement;
  private delivery: HTMLSelectElement;
  private destination: HTMLSelectElement;
  private destinationField: HTMLLabelElement;
  private instructions: HTMLParagraphElement;
  private registration: HTMLElement;
  private status: HTMLParagraphElement;
  private sources: HTMLDivElement;
  private save: HTMLButtonElement;
  private revision = 0;
  private busy = false;
  private loaded = false;
  constructor(private client: () => FleetClient | undefined) {
    this.dialog.className = "notification-settings";
    this.dialog.innerHTML = `<div class="dialog-heading"><h2>Glance notifications</h2><button type="button" class="subtle" aria-label="Close notifications">✕</button></div>
      <p class="caption">Choose which computer's completion notifications to configure.</p>
      <label>Computer<select aria-label="Notification source computer"></select></label>
      <label>Send notifications<select aria-label="Notification delivery"><option value="direct">Directly from this computer</option><option value="relay">Through a central computer</option></select></label>
      <label data-notification-destination>Central computer<select aria-label="Central notification computer"></select></label>
      <p class="caption" data-notification-instructions></p>
      <section class="notification-connection"><h3>Glance watcher</h3><p data-glance-computer></p><code data-glance-registration></code><p class="caption">Use this computer's connection key as the Credential. Choose PUSH in Glance and save/register the watcher.</p></section>
      <p class="caption" role="status"></p><div class="relay-sources"></div>
      <button type="button" class="primary">Save notification settings</button>`;
    const selects = this.dialog.querySelectorAll("select");
    this.source = selects[0]; this.delivery = selects[1]; this.destination = selects[2];
    this.destinationField = this.dialog.querySelector("[data-notification-destination]")!;
    this.instructions = this.dialog.querySelector("[data-notification-instructions]")!;
    this.registration = this.dialog.querySelector("[data-glance-registration]")!;
    this.status = this.dialog.querySelector('[role="status"]')!; this.sources = this.dialog.querySelector(".relay-sources")!;
    this.save = this.dialog.querySelector(".primary")!;
    this.dialog.querySelector<HTMLButtonElement>('[aria-label="Close notifications"]')!.onclick = () => this.dialog.close();
    this.source.onchange = () => { void this.load(); };
    this.delivery.onchange = this.destination.onchange = () => this.describeRoute();
    this.save.onclick = () => { void this.configure(); };
    this.dialog.addEventListener("close", () => { this.revision++; }); document.body.append(this.dialog);
  }
  open(preferredUrl?: string) {
    const client = this.client(), hosts = client?.hosts() || [];
    this.source.replaceChildren(...hosts.map(host => new Option(`${host.name}${host.online ? "" : " (offline)"}`, host.url)));
    this.source.value = preferredUrl || client?.activeUrl() || hosts[0]?.url || "";
    if (!this.dialog.open) this.dialog.showModal(); void this.load();
  }
  private lock(value: boolean) {
    this.busy = value; this.source.disabled = value;
    this.delivery.disabled = this.destination.disabled = this.save.disabled = value || !this.loaded;
  }
  private describeRoute() {
    const central = this.delivery.value === "relay", url = central ? this.destination.value : this.source.value;
    this.destinationField.hidden = !central;
    const sourceName = this.source.selectedOptions[0]?.textContent || "this computer";
    this.instructions.textContent = central
      ? `Only ${sourceName} forwards its completion notifications. The central computer needs FCM credentials and a Glance PUSH watcher.`
      : `Only ${sourceName} sends directly. This computer needs FCM credentials and its own Glance PUSH watcher.`;
    const name = central ? this.destination.selectedOptions[0]?.textContent : sourceName;
    this.dialog.querySelector("[data-glance-computer]")!.textContent = name ? `Connect Glance to ${name}:` : "Choose a central computer first.";
    this.registration.textContent = url ? url + "/api/glance" : "—";
  }
  private async load() {
    const client = this.client(), url = this.source.value, request = ++this.revision;
    const hosts = client?.hosts() || [];
    this.loaded = false;
    this.delivery.value = "direct";
    this.destination.replaceChildren(...hosts.filter(host => host.url !== url && host.online)
      .map(host => new Option(host.name, host.url)));
    this.sources.replaceChildren(); this.status.textContent = "Loading notification settings…";
    this.save.disabled = this.delivery.disabled = this.destination.disabled = true;
    this.describeRoute();
    if (!client || !url) { this.status.textContent = "Connect a computer first."; return; }
    if (!hosts.some(host => host.url === url && host.online)) { this.status.textContent = "This computer is offline. Its saved notification settings are retained."; return; }
    try {
      const [routing, push] = await Promise.all([client.requestFrom(url, "/api/glance/routing"), client.requestFrom(url, "/api/glance/push")]);
      if (request !== this.revision) return;
      if (routing.target && ![...this.destination.options].some(option => option.value === routing.target.url))
        this.destination.append(new Option(`${routing.target.name} (saved)`, routing.target.url));
      this.delivery.value = routing.mode === "relay" ? "relay" : "direct";
      if (routing.target) this.destination.value = routing.target.url;
      this.describeRoute();
      this.status.textContent = routing.mode === "relay" ? `Saved: forwarding through ${routing.target.name} · ${routing.queued} queued · ${routing.lastResult || "Ready"}`
        : `Saved: direct · ${routing.senderConfigured ? "FCM configured" : "FCM not configured"} · ${push.subscriptions.length} Glance watcher(s).`;
      for (const peer of routing.sources) {
        const row = document.createElement("p"), name = document.createElement("span"), remove = document.createElement("button");
        name.textContent = `Receiving notifications from ${peer.name} `; remove.type = "button"; remove.className = "text-button"; remove.textContent = "Remove forwarder";
        remove.onclick = async () => {
          if (this.busy) return; this.lock(true);
          try { await client.requestFrom(url, "/api/glance/relay/revoke", { sourceId: peer.id }); await this.load(); }
          catch { this.status.textContent = "Could not remove this notification forwarder."; } finally { this.lock(false); }
        };
        row.append(name, remove); this.sources.append(row);
      }
      this.loaded = true; this.save.disabled = this.delivery.disabled = this.destination.disabled = false;
    } catch { if (request === this.revision) this.status.textContent = "Could not load notification settings. Check this computer's connection and backend version."; }
  }
  private async configure() {
    if (this.busy || this.save.disabled) return;
    const client = this.client(), url = this.source.value, direct = this.delivery.value === "direct", targetUrl = this.destination.value;
    if (!client || !url) return;
    if (!direct && (!targetUrl || targetUrl === url)) { this.status.textContent = "Choose another computer as the notification center."; return; }
    this.lock(true); this.status.textContent = "Saving…";
    try {
      if (direct) await client.requestFrom(url, "/api/glance/routing", { mode: "direct" });
      else {
        const source = await client.requestFrom(url, "/api/host");
        const peer = await client.requestFrom(targetUrl, "/api/glance/relay/register", { sourceId: source.id, sourceName: source.name });
        await client.requestFrom(url, "/api/glance/routing", { mode: "relay", target: { ...peer, url: targetUrl } });
      }
      await this.load();
    } catch { this.status.textContent = "Could not confirm notification settings. Check the connection before trying again."; }
    finally { this.lock(false); }
  }
}
