import type { RuntimeState } from "../../../../packages/cockpit-state/types.js";
import type { BridgeApi } from "../bridge/client.js";
import type { SessionSummary } from "./panel.js";
import { mergeSessionState } from "./live.js";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
export class DesktopSessions {
  private root = element("section", "", "desktop-session-panel");
  private rows = element("div", "", "desktop-session-list");
  private status = element("p", "Connecting…", "desktop-session-summary");
  private search = element("input");
  private watched = element("button", "Watched", "outline");
  private all = element("button", "All sessions", "outline");
  private filter: "watched" | "all" = "watched";
  private sessions: SessionSummary[] = [];
  private state?: RuntimeState;
  private pending = false;
  private loaded = false;
  private rendered = "";
  private timer: ReturnType<typeof setInterval>;
  constructor(private client: () => BridgeApi | undefined, private notice: (text: string) => void, create: () => void) {
    const heading = element("div", "", "panel-heading");
    const title = element("div", "", "desktop-session-title");
    title.append(element("h1", "Sessions"), this.status);
    const add = element("button", "+ New terminal", "outline"); add.onclick = create; heading.append(title, add);
    const toolbar = element("div", "", "desktop-session-toolbar");
    const tabs = element("div", "", "desktop-session-tabs"); tabs.setAttribute("aria-label", "Session filters");
    this.watched.onclick = () => { this.filter = "watched"; this.render(); };
    this.all.onclick = () => { this.filter = "all"; this.render(); void this.load(); };
    tabs.append(this.watched, this.all);
    this.search.type = "search"; this.search.placeholder = "Search sessions or projects"; this.search.setAttribute("aria-label", "Search sessions");
    this.search.oninput = () => this.render(); toolbar.append(tabs, this.search);
    this.rows.setAttribute("aria-label", "Sessions ordered by latest update");
    const help = element("p", "Watch defaults to the last 24 hours on desktop open. New external sessions appear under All sessions after their first saved prompt. Glasses show watched sessions only. Unwatch keeps tasks running.", "caption desktop-watch-help");
    this.root.append(heading, toolbar, help, this.rows);
    document.querySelector(".workspace")!.before(this.root);
    this.timer = setInterval(() => { if (!document.hidden) void this.load(); }, 3000);
  }
  update(state: RuntimeState) {
    this.state = state;
    this.sessions = mergeSessionState(this.sessions, state);
    if (!this.loaded) void this.load();
    this.render();
  }
  close() { clearInterval(this.timer); }
  private loading = false;
  async load() {
    if (this.loading || this.pending || !this.client()) return;
    this.loading = true;
    try {
      const result = await this.client()!.request("/api/sessions") as { sessions: SessionSummary[] };
      this.loaded = true;
      this.sessions = this.state ? mergeSessionState(result.sessions, this.state) : result.sessions;
      this.render();
    } catch { this.status.textContent = "Reconnecting · watch selections retained"; }
    finally { this.loading = false; }
  }
  private render() {
    const search = this.search.value.trim().toLowerCase();
    const watched = this.sessions.filter(s => s.monitored);
    const running = watched.filter(s => s.live && s.runtimeStatus === "running").length;
    const sessions = this.sessions.filter(s => (this.filter === "all" || s.monitored) &&
      [s.name, s.preview, s.cwd, s.model, s.tunnel, s.source?.name].some(value => value?.toLowerCase().includes(search)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
    this.status.textContent = `${watched.length} watched · ${running} running · latest update first`;
    this.watched.textContent = `Watched (${watched.length})`; this.all.textContent = this.loaded ? `All sessions (${this.sessions.length})` : "All sessions";
    this.watched.setAttribute("aria-pressed", String(this.filter === "watched"));
    this.all.setAttribute("aria-pressed", String(this.filter === "all"));
    const signature = JSON.stringify([sessions, this.pending, this.state?.session.key, search, this.filter]);
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
      check.onchange = () => { void this.act(`/api/runtime/${session.key}/monitor`, { monitored: check.checked },
        check.checked ? "Session watched." : "Unwatched. Your terminal and running task continue."); };
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
      choose.onclick = () => { void this.act("/api/session/resume", { key: session.key }, "Session selected. Prompts go to this terminal."); };
      controls.append(choose);
      if (selected) row.classList.add("selected");
      row.append(watchLabel, identity, detail, controls); this.rows.append(row);
    }
    if (!sessions.length) {
      const empty = element("div", "", "desktop-session-empty");
      empty.append(element("p", search ? "No matching sessions." : "No watched sessions."));
      if (!search && this.filter === "watched") {
        const browse = element("button", "Browse all sessions", "outline");
        browse.onclick = () => { this.filter = "all"; this.render(); }; empty.append(browse);
      }
      this.rows.append(empty);
    }
  }
  private async act(path: string, body: unknown, success: string) {
    if (this.pending || !this.client()) return;
    this.pending = true; this.render();
    try {
      this.state = await this.client()!.request(path, body) as RuntimeState;
      this.sessions = mergeSessionState(this.sessions, this.state);
      this.notice(success);
    } catch (error) { this.notice(error instanceof Error ? error.message : "Action failed"); }
    finally { this.pending = false; this.render(); await this.load(); }
  }
}
