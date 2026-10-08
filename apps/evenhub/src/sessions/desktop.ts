import type { RuntimeState } from "../../../../packages/cockpit-state/types.js";
import type { BridgeApi } from "../bridge/client.js";
import type { SessionSummary } from "./panel.js";
import { mergeSessionState } from "./live.js";
import { deviceKey, sessionGroups, type SessionScope } from "./groups.js";
import { SessionFilterDropdowns } from "./filters.js";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
export class DesktopSessions {
  private root = element("section", "", "desktop-session-panel");
  private rows = element("div", "", "desktop-session-list");
  private status = element("p", "Connecting…", "desktop-session-summary");
  private search = element("input");
  private selectedDevices: string[] = [];
  private filter: SessionScope = "watched";
  private filters = new SessionFilterDropdowns({
    scope: value => { this.filter = value; this.render(); if (value === "all") void this.load(); },
    devices: value => { this.selectedDevices = value; this.render(); },
  });
  private sessions: SessionSummary[] = [];
  private state?: RuntimeState;
  private pending = false;
  private loaded = false;
  private rendered = "";
  private closed = false;
  private listRequest = 0;
  private stateVersion = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private client: () => BridgeApi | undefined, private notice: (text: string) => void, create: () => void,
    private viewHistory?: (session: SessionSummary) => void) {
    const heading = element("div", "", "panel-heading");
    const title = element("div", "", "desktop-session-title");
    title.append(element("h1", "Sessions"), this.status);
    const add = element("button", "+ New terminal", "outline"); add.onclick = create; heading.append(title, add);
    const toolbar = element("div", "", "desktop-session-toolbar");
    this.search.type = "search"; this.search.placeholder = "Search sessions or projects"; this.search.setAttribute("aria-label", "Search sessions");
    this.search.oninput = () => this.render(); toolbar.append(this.filters.element, this.search);
    this.rows.setAttribute("aria-label", "Sessions ordered by latest update");
    const help = element("p", "This computer's Watch defaults to the last 24 hours when opened from its desktop shortcut. New external sessions appear under All sessions after their first saved prompt. Glasses show watched sessions only. Unwatch keeps tasks running.", "caption desktop-watch-help");
    this.root.append(heading, toolbar, help, this.rows);
    document.querySelector(".workspace")!.before(this.root);
    this.timer = setInterval(() => { if (!document.hidden) void this.load(); }, 3000);
  }
  update(state: RuntimeState) {
    if (this.closed) return;
    this.state = state; this.stateVersion++;
    this.sessions = this.reconcile(mergeSessionState(this.reconcile(this.sessions), state));
    if (!this.loaded) void this.load();
    this.render();
  }
  showDevice(url: string) {
    if (this.closed) return;
    const host = this.hosts()?.find(host => host.url === url);
    this.selectedDevices = host ? [deviceKey(host)] : [];
    this.render();
  }
  close() { this.closed = true; this.listRequest++; clearInterval(this.timer); }
  private hosts() { return this.client()?.hosts?.() || this.state?.hosts; }
  private reconcile(sessions: SessionSummary[]) {
    const hosts = this.hosts();
    if (!hosts) return sessions;
    return sessions.flatMap(session => {
      if (!session.source) return [session];
      const host = hosts.find(host => deviceKey(host) === deviceKey(session.source));
      if (!host) return [];
      return [{ ...session, source: host, ...(host.online === false ? { live: false, runtimeStatus: "offline" as const } : {}) }];
    });
  }
  private loading = false;
  async load() {
    const client = this.client();
    if (this.closed || this.loading || this.pending || !client) return;
    const request = ++this.listRequest;
    this.loading = true;
    try {
      const result = await client.request("/api/sessions") as { sessions: SessionSummary[] };
      if (this.closed || request !== this.listRequest || client !== this.client()) return;
      this.loaded = true;
      this.sessions = this.reconcile(this.state ? mergeSessionState(result.sessions, this.state) : result.sessions);
      this.render();
    } catch { if (!this.closed && request === this.listRequest && client === this.client()) this.status.textContent = "Reconnecting · watch selections retained"; }
    finally { this.loading = false; }
  }
  private render() {
    this.sessions = this.reconcile(this.sessions);
    const search = this.search.value.trim().toLowerCase();
    const groups = sessionGroups(this.sessions, this.hosts() || []);
    this.selectedDevices = this.selectedDevices.filter(key => groups.some(group => group.key === key));
    this.filters.update(this.filter, this.selectedDevices, groups);
    const watched = this.sessions.filter(s => s.monitored);
    const running = watched.filter(s => s.live && s.runtimeStatus === "running").length;
    const sessions = sessionGroups(this.sessions, this.hosts() || [], { devices: this.selectedDevices, scope: this.filter, search }).flatMap(group => group.sessions)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
    this.status.textContent = `${watched.length} watched · ${running} running · latest update first`;
    const signature = JSON.stringify([sessions, this.pending, this.state?.session.key, search, this.filter, this.selectedDevices]);
    if (signature === this.rendered) return;
    this.rendered = signature;
    this.rows.replaceChildren();
    for (const session of sessions) {
      const name = session.name || session.preview || "Untitled session";
      const selected = this.state?.session.key === session.key;
      const row = element("article", "", "desktop-session-row"); row.dataset.sessionKey = session.key;
      const watchLabel = element("label", "", "desktop-watch");
      const check = element("input"); check.type = "checkbox"; check.checked = !!session.monitored;
      check.disabled = this.pending || session.source?.online === false; check.setAttribute("aria-label", `Watch ${name}`);
      check.title = session.monitored ? "Unwatch only. Keep the terminal and task running." : "Watch this session. Open terminals stay in place.";
      check.onchange = () => { void this.act(`/api/runtime/${encodeURIComponent(session.key)}/monitor`, { monitored: check.checked },
        check.checked ? "Session watched." : "Unwatched. Your terminal and running task continue.", session.key); };
      watchLabel.append(check, element("span", "Watch"));
      const identity = element("div", "", "desktop-session-identity");
      identity.append(element("strong", name), element("small", session.cwd));
      identity.append(element("small", (session.source ? session.source.name + " · " : "") + (session.tunnel || "pi").toUpperCase() + " · " + (session.model || "—")));
      const badge = element("span", session.source?.online === false ? "HOST OFFLINE" : session.live ? session.runtimeStatus.toUpperCase() : "NOT CONNECTED", "session-badge");
      badge.title = session.live ? "Live terminal monitor connected" : "Saved session; no live terminal activity detected.";
      if (session.live && session.runtimeStatus === "running") badge.classList.add("running");
      const detail = element("div", "", "desktop-session-detail"); detail.append(badge);
      if (selected) detail.append(element("span", "SELECTED", "session-badge"));
      detail.append(element("small", session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "No recent update"));
      const controls = element("div", "", "desktop-row-actions");
      const choose = element("button", session.live ? selected ? "Selected" : "Select" : "Open terminal ↗", "outline");
      choose.disabled = this.pending || session.source?.online === false || !!(session.live && selected);
      choose.setAttribute("aria-label", `${session.live ? "Select" : "Open terminal"}: ${name}`);
      choose.onclick = () => { void this.act("/api/session/resume", { key: session.key }, "Session selected. Prompts go to this terminal.", session.key); };
      controls.append(choose);
      if (this.viewHistory) {
        const history = element("button", "History", "text-button desktop-session-history"); history.type = "button";
        history.disabled = this.pending || session.source?.online === false; history.setAttribute("aria-label", `View history: ${name}`);
        history.onclick = () => {
          const current = this.reconcile(this.sessions).find(row => row.key === session.key);
          if (!this.closed && !this.pending && current && current.source?.online !== false) this.viewHistory?.(current);
        };
        controls.append(history);
      }
      if (selected) row.classList.add("selected");
      row.append(watchLabel, identity, detail, controls); this.rows.append(row);
    }
    if (!sessions.length) {
      const empty = element("div", "", "desktop-session-empty");
      empty.append(element("p", search ? "No matching sessions." : this.filter === "watched" ? "No watched sessions." : this.filter === "running" ? "No running sessions." : "No saved sessions yet."));
      if (!search && this.filter === "watched") {
        const browse = element("button", "Browse all sessions", "outline");
        browse.onclick = () => { this.filter = "all"; this.render(); }; empty.append(browse);
      }
      this.rows.append(empty);
    }
  }
  private async act(path: string, body: unknown, success: string, key: string) {
    const client = this.client(), session = this.reconcile(this.sessions).find(row => row.key === key);
    if (this.closed || this.pending || !client || !session || session.source?.online === false) return;
    const version = this.stateVersion;
    this.pending = true; this.render();
    try {
      const state = await client.request(path, body) as RuntimeState;
      if (this.closed || client !== this.client()) return;
      if (version === this.stateVersion) {
        this.state = state; this.stateVersion++;
        this.sessions = this.reconcile(mergeSessionState(this.sessions, state));
      }
      this.notice(success);
    } catch (error) { if (!this.closed && client === this.client()) this.notice(error instanceof Error ? error.message : "Action failed"); }
    finally { this.pending = false; if (!this.closed) { this.render(); await this.load(); } }
  }
}
