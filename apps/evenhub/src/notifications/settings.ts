import { BridgeClient } from "../bridge/client.js";
import type { FleetClient } from "../bridge/fleet.js";

interface SavedTarget { id: string; name: string; url: string }
function centerOrigin(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter the center's full HTTP(S) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Use the center's HTTP(S) URL without a path or credentials.");
  return url.origin;
}

/** Desktop configures only its own notifications; a center is never added as a session viewer. */
export class NotificationSettings {
  private dialog = document.createElement("dialog");
  private source: HTMLSelectElement;
  private delivery: HTMLSelectElement;
  private destination: HTMLSelectElement;
  private destinationField: HTMLLabelElement;
  private centerField: HTMLDivElement;
  private centerUrl: HTMLInputElement;
  private centerKey: HTMLInputElement;
  private instructions: HTMLParagraphElement;
  private registration: HTMLElement;
  private status: HTMLParagraphElement;
  private sources: HTMLDivElement;
  private save: HTMLButtonElement;
  private close: HTMLButtonElement;
  private revision = 0;
  private busy = false;
  private loaded = false;
  private savedTarget?: SavedTarget;
  private registrationUrl = "";
  constructor(private client: () => FleetClient | undefined, private servingOrigin?: string) {
    this.dialog.className = "notification-settings";
    this.dialog.innerHTML = `<div class="dialog-heading"><h2>Glance notifications</h2><button type="button" class="subtle" aria-label="Close notifications">✕</button></div>
      <p class="caption" data-notification-caption></p>
      <label data-notification-source>Computer<select aria-label="Notification source computer"></select></label>
      <label>Send notifications<select aria-label="Notification delivery"><option value="direct">Directly from this computer</option><option value="relay">Through a central computer</option></select></label>
      <label data-notification-destination>Central computer<select aria-label="Central notification computer"></select></label>
      <div data-notification-center><label>Center URL<input data-notification-center-url type="url" spellcheck="false" placeholder="Paste the center URL" autocomplete="off"></label><label>Center connection key<input data-notification-center-key type="password" placeholder="Paste the center's connection key" autocomplete="off" maxlength="4096"></label><p class="caption">Only needed when connecting or reconnecting a center. Leave the key empty to keep the saved center.</p></div>
      <p class="caption" data-notification-instructions></p>
      <section class="notification-connection"><h3>Glance watcher</h3><p data-glance-computer></p><code data-glance-registration></code><p class="caption">Use that computer's connection key as the Credential. Choose PUSH in Glance and save/register the watcher.</p></section>
      <p class="caption" role="status"></p><div class="relay-sources"></div>
      <button type="button" class="primary">Save notification settings</button>`;
    const selects = this.dialog.querySelectorAll("select");
    this.source = selects[0]; this.delivery = selects[1]; this.destination = selects[2];
    this.destinationField = this.dialog.querySelector("[data-notification-destination]")!;
    this.centerField = this.dialog.querySelector("[data-notification-center]")!;
    this.centerUrl = this.dialog.querySelector("[data-notification-center-url]")!;
    this.centerKey = this.dialog.querySelector("[data-notification-center-key]")!;
    this.dialog.querySelector<HTMLElement>("[data-notification-source]")!.hidden = Boolean(servingOrigin);
    this.dialog.querySelector("[data-notification-caption]")!.textContent = servingOrigin
      ? "Notifications for this computer." : "Choose which computer's completion notifications to configure.";
    this.instructions = this.dialog.querySelector("[data-notification-instructions]")!;
    this.registration = this.dialog.querySelector("[data-glance-registration]")!;
    this.status = this.dialog.querySelector('[role="status"]')!; this.sources = this.dialog.querySelector(".relay-sources")!;
    this.save = this.dialog.querySelector(".primary")!;
    this.close = this.dialog.querySelector<HTMLButtonElement>('[aria-label="Close notifications"]')!;
    this.close.onclick = () => { if (!this.busy) this.dialog.close(); };
    this.source.onchange = () => { if (!this.servingOrigin && !this.busy) void this.load(); };
    this.delivery.onchange = this.destination.onchange = () => this.describeRoute();
    this.centerUrl.oninput = () => this.describeRoute();
    this.save.onclick = () => { void this.configure(); };
    this.dialog.addEventListener("cancel", event => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener("close", () => {
      // Registration can rotate an existing relay credential. A programmatic
      // close must let that authorized Save finish on its captured source.
      if (!this.busy) this.revision++;
      this.centerKey.value = "";
    }); document.body.append(this.dialog);
  }
  private sourceUrl() { return this.servingOrigin || this.source.value; }
  private current(client: FleetClient, url: string, revision: number) {
    return revision === this.revision && this.dialog.open && client === this.client() && url === this.sourceUrl();
  }
  open(preferredUrl?: string) {
    if (this.busy) return;
    const client = this.client(), hosts = client?.hosts() || [];
    this.source.replaceChildren(...hosts.map(host => new Option(`${host.name}${host.online ? "" : " (offline)"}`, host.url)));
    this.source.value = this.servingOrigin || preferredUrl || client?.activeUrl() || hosts[0]?.url || "";
    if (!this.dialog.open) this.dialog.showModal(); void this.load();
  }
  private lock(value: boolean) {
    this.busy = value; this.close.disabled = value; this.source.disabled = value || Boolean(this.servingOrigin);
    this.delivery.disabled = this.destination.disabled = this.centerUrl.disabled = this.centerKey.disabled = this.save.disabled = value || !this.loaded;
  }
  private describeRoute() {
    const central = this.delivery.value === "relay";
    let targetUrl = this.servingOrigin ? this.centerUrl.value.trim() : this.destination.value;
    try { if (targetUrl) targetUrl = centerOrigin(targetUrl); } catch { targetUrl = ""; }
    const url = central ? targetUrl && targetUrl + "/api/glance" : this.registrationUrl;
    this.destinationField.hidden = !central || Boolean(this.servingOrigin);
    this.centerField.hidden = !central || !this.servingOrigin;
    const sourceName = this.servingOrigin ? "this computer" : this.source.selectedOptions[0]?.textContent || "this computer";
    this.instructions.textContent = central
      ? `Only ${sourceName} forwards its completion notifications. Configure Glance PUSH and FCM on the center.`
      : `Only ${sourceName} sends directly. Configure Glance PUSH and FCM here.`;
    const name = central ? this.savedTarget?.url === targetUrl ? this.savedTarget.name
      : this.servingOrigin ? "the center" : this.destination.selectedOptions[0]?.textContent : sourceName;
    this.dialog.querySelector("[data-glance-computer]")!.textContent = url && name ? `Connect Glance to ${name}:`
      : central ? "Enter or choose a center first." : "Open Connect phone to find this computer's reachable URL.";
    this.registration.textContent = url || "—";
  }
  private async load() {
    const client = this.client(), url = this.sourceUrl(), request = ++this.revision;
    const hosts = client?.hosts() || [];
    this.loaded = false; this.savedTarget = undefined; this.centerUrl.value = this.centerKey.value = "";
    this.registrationUrl = this.servingOrigin ? "" : url ? url + "/api/glance" : "";
    this.delivery.value = "direct";
    this.destination.replaceChildren(...hosts.filter(host => host.url !== url && host.online)
      .map(host => new Option(host.name, host.url)));
    this.sources.replaceChildren(); this.status.textContent = "Loading notification settings…";
    this.lock(false); this.describeRoute();
    if (!client || !url) { this.status.textContent = "Connect a computer first."; return; }
    if (!hosts.some(host => host.url === url && host.online)) { this.status.textContent = "This computer is offline. Its saved notification settings are retained."; return; }
    try {
      const [routing, push, pairing] = await Promise.all([client.requestFrom(url, "/api/glance/routing"), client.requestFrom(url, "/api/glance/push"),
        this.servingOrigin ? client.requestFrom(url, "/api/pairing").catch(() => undefined) : undefined]);
      if (!this.current(client, url, request)) return;
      if (pairing?.registrationUrl) this.registrationUrl = pairing.registrationUrl;
      this.savedTarget = routing.mode === "relay" ? routing.target : undefined;
      if (routing.target && ![...this.destination.options].some(option => option.value === routing.target.url))
        this.destination.append(new Option(`${routing.target.name} (saved)`, routing.target.url));
      this.delivery.value = routing.mode === "relay" ? "relay" : "direct";
      if (routing.target) { this.destination.value = routing.target.url; this.centerUrl.value = routing.target.url; }
      this.describeRoute();
      this.status.textContent = routing.mode === "relay" ? `Saved: forwarding through ${routing.target.name} · ${routing.queued} queued · ${routing.lastResult || "Ready"}`
        : `Saved: direct · ${routing.senderConfigured ? "FCM configured" : "FCM not configured"} · ${push.subscriptions.length} Glance watcher(s).`;
      for (const peer of routing.sources) {
        const row = document.createElement("p"), name = document.createElement("span"), remove = document.createElement("button");
        name.textContent = `Receiving notifications from ${peer.name} `; remove.type = "button"; remove.className = "text-button"; remove.textContent = "Remove forwarder";
        remove.onclick = () => {
          if (this.busy || !this.loaded || !this.current(client, url, request)) return;
          const operation = ++this.revision; this.lock(true);
          void (async () => {
            try {
              await client.requestFrom(url, "/api/glance/relay/revoke", { sourceId: peer.id });
              if (this.current(client, url, operation)) await this.load();
            } catch {
              if (this.current(client, url, operation)) { this.loaded = false; this.status.textContent = "Could not confirm removal. Reopen settings to check this computer."; }
            } finally { if (operation === this.revision) this.lock(false); }
          })();
        };
        row.append(name, remove); this.sources.append(row);
      }
      this.loaded = true; this.lock(false);
    } catch { if (this.current(client, url, request)) this.status.textContent = "Could not load notification settings. Check this computer's connection and backend version."; }
  }
  private async configure() {
    if (this.busy || this.save.disabled) return;
    const client = this.client(), url = this.sourceUrl(), direct = this.delivery.value === "direct";
    let targetUrl = this.servingOrigin ? this.centerUrl.value : this.destination.value;
    const key = this.centerKey.value.trim();
    if (!client || !url) return;
    if (!direct) {
      try { targetUrl = centerOrigin(targetUrl); } catch (error) { this.status.textContent = (error as Error).message; return; }
      if (targetUrl === url) { this.status.textContent = "Choose another computer as the notification center."; return; }
      if (this.servingOrigin && (targetUrl !== this.savedTarget?.url || key) && (key.length < 24 || key.length > 4096)) {
        this.status.textContent = "Enter the center's connection key (at least 24 characters)."; return;
      }
      // Keep the stored relay key and pending notifications when the center is unchanged.
      if (targetUrl === this.savedTarget?.url && (!this.servingOrigin || !key)) { await this.load(); return; }
    }
    const request = ++this.revision;
    this.lock(true); this.status.textContent = "Saving…";
    try {
      if (direct) await client.requestFrom(url, "/api/glance/routing", { mode: "direct" });
      else {
        const source = await client.requestFrom(url, "/api/host");
        if (request !== this.revision) return;
        const peer = this.servingOrigin
          ? await new BridgeClient({ url: targetUrl, token: key }, () => {}, () => {}, () => {})
            .request("/api/glance/relay/register", { sourceId: source.id, sourceName: source.name })
          : await client.requestFrom(targetUrl, "/api/glance/relay/register", { sourceId: source.id, sourceName: source.name });
        if (request !== this.revision) return;
        this.centerKey.value = "";
        await client.requestFrom(url, "/api/glance/routing", { mode: "relay", target: { id: peer.id, name: peer.name, key: peer.key, url: targetUrl } });
      }
      if (this.current(client, url, request)) await this.load();
    } catch {
      if (this.current(client, url, request)) { this.loaded = false; this.status.textContent = "Could not confirm notification settings. Reopen settings to check the saved route before trying again."; }
    } finally { if (request === this.revision) this.lock(false); }
  }
}
