import type { RuntimeState, Tunnel, HostSource } from "../../../../packages/cockpit-state/types.js";
import type { BridgeApi } from "../bridge/client.js";
import { mergeSessionState, monitoringSignature } from "./live.js";
import { deviceKey, sessionAge, sessionGroups, type SessionScope } from "./groups.js";
import { SessionFilterDropdowns } from "./filters.js";

export interface SessionSummary {
  key: string;
  id: string;
  name?: string;
  preview?: string;
  cwd: string;
  model?: string;
  tunnel?: Tunnel;
  source?: HostSource;
  updatedAt?: number;
  messageCount?: number;
  runtimeStatus: "offline" | "idle" | "running" | "waiting" | "failed";
  owned?: boolean;
  monitored?: boolean;
  live?: boolean;
}
interface SessionHistory {
  session: SessionSummary;
  messages: { role: string; text: string }[];
  truncated?: boolean;
}
interface PanelOptions {
  client: () => BridgeApi | undefined;
  changed: (message: string) => void;
  busy: (value: boolean) => void;
  mount?: HTMLElement;
  opened?: () => void;
  connect?: () => void;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function sessionName(session: SessionSummary) {
  return session.name || session.preview || "Untitled session";
}

/** Selecting a session opens it immediately; History remains a separate read-only action. */
export class SessionsPanel {
  private dialog = element("dialog", undefined, "sessions-dialog");
  private sessions: SessionSummary[] = [];
  private state?: RuntimeState;
  private online = false;
  private loading = false;
  private mutating = false;
  private selected?: SessionSummary;
  private history?: SessionHistory;
  private historyRequest = 0;
  private listRequest = 0;
  private statusKey = "";
  private membershipKey = "";
  private mode: "browse" | "new" = "browse";
  private notice = element("p", "", "sessions-notice");
  private list = element("div", undefined, "session-list");
  private historyView = element("div", undefined, "session-history");
  private project = element("select");
  private search = element("input");
  private selectedDevices: string[] = [];
  private scope: SessionScope = "all";
  private filters = new SessionFilterDropdowns({
    scope: value => { this.scope = value; this.limits.clear(); this.renderList(); },
    devices: value => { this.selectedDevices = value; this.limits.clear(); this.renderList(); },
  });
  private collapsed = new Set<string>();
  private limits = new Map<string, number>();
  private cwd = element("input");
  private name = element("input");
  private tunnel = element("select");
  private computer = element("select");
  private hostSignature = "";
  private create = element("button", "CREATE SESSION +", "primary");
  private resume = element("button", "OPEN SESSION →", "primary");
  private refresh = element("button", "REFRESH ↻", "outline");
  private browsePane = element("section", undefined, "sessions-browse");
  private newPane = element("form", undefined, "session-create");

  constructor(private options: PanelOptions) {
    this.dialog.setAttribute("aria-labelledby", "sessions-title");
    const header = element("div", undefined, "dialog-heading");
    const title = element("h2", options.mount ? "NEW SESSION" : "SESSIONS"); title.id = "sessions-title";
    const close = element("button", "✕", "subtle"); close.type = "button"; close.setAttribute("aria-label", "Close sessions");
    close.onclick = () => this.dialog.close(); header.append(title, close);
    const tabs = element("nav", undefined, "sessions-tabs");
    tabs.setAttribute("aria-label", "Session manager views");
    const browse = element("button", "SAVED SESSIONS", "outline");
    const create = element("button", "NEW SESSION +", "outline");
    browse.type = create.type = "button";
    browse.onclick = () => { this.setMode("browse"); void this.load(); };
    create.onclick = () => this.setMode("new"); tabs.append(browse, create);
    this.notice.setAttribute("role", "status"); this.notice.hidden = true;
    const filters = element("div", undefined, "session-filters");
    const projectLabel = element("label", "PROJECT"); projectLabel.hidden = !!options.mount; this.project.setAttribute("aria-label", "Filter sessions by project");
    projectLabel.append(this.project);
    const searchLabel = element("label", "SEARCH"); this.search.type = "search"; this.search.placeholder = "Name, model or project";
    this.search.setAttribute("aria-label", "Search sessions"); searchLabel.append(this.search);
    this.project.onchange = () => this.renderList(); this.search.oninput = () => this.renderList();
    this.refresh.textContent = "Refresh";
    this.refresh.type = "button"; this.refresh.onclick = () => void this.load(); filters.append(searchLabel, projectLabel, this.refresh, this.filters.element);
    const columns = element("div", undefined, "session-columns");
    this.list.setAttribute("aria-label", "Saved sessions"); this.list.setAttribute("role", "region");
    this.historyView.setAttribute("aria-label", "Saved session history"); this.historyView.setAttribute("role", "region");
    columns.append(this.list, this.historyView); this.browsePane.append(filters, columns);
    this.historyView.hidden = !!options.mount;
    const cwdLabel = element("label", "PROJECT DIRECTORY ON YOUR PC"); this.cwd.required = true;
    this.cwd.placeholder = "Project path on the selected computer"; this.cwd.setAttribute("aria-label", "New session project directory"); cwdLabel.append(this.cwd);
    const nameLabel = element("label", "SESSION NAME (OPTIONAL)"); this.name.maxLength = 120;
    this.name.placeholder = "What are you working on?"; this.name.setAttribute("aria-label", "New session name"); nameLabel.append(this.name);
    this.create.type = "submit";
    const tunnelLabel = element("label", "TUNNEL");
    this.tunnel.setAttribute("aria-label", "New session tunnel");
    for (const [value, title] of [["pi", "Pi"], ["codex", "Codex"], ["claude", "Claude Code"]]) {
      const option = element("option", title); option.value = value; this.tunnel.append(option);
    }
    tunnelLabel.append(this.tunnel);
    const newHelp = element("p", "The agent will use this directory for its tools. The directory must already exist on the host computer.", "caption");
    const computerLabel = element("label", "COMPUTER"); this.computer.setAttribute("aria-label", "Computer for new session"); computerLabel.append(this.computer);
    this.computer.onchange = () => { this.cwd.value = this.sessions.find(session => session.source?.url === this.computer.value)?.cwd || ""; this.updateButtons(); };
    this.newPane.append(computerLabel, tunnelLabel, cwdLabel, nameLabel, newHelp, this.create);
    this.newPane.onsubmit = event => {
      event.preventDefault();
      void this.mutate("/api/session/new", { cwd: this.cwd.value.trim(), name: this.name.value.trim() || undefined, tunnel: this.tunnel.value, sourceUrl: this.computer.value || undefined }, "New session ready.");
    };
    this.dialog.append(header, tabs, this.notice, this.browsePane, this.newPane);
    document.body.append(this.dialog);
    if (options.mount) {
      tabs.hidden = true;
      const heading = element("div", undefined, "hub-sessions-heading");
      const text = element("div"); text.append(element("h1", "Sessions"), element("p", "Choose a device, then a session.", "caption"));
      const add = element("button", "+ New", "outline"); add.type = "button";
      add.onclick = () => this.open("new"); heading.append(text, add);
      options.mount.replaceChildren(heading, this.notice, this.browsePane);
      this.dialog.addEventListener("close", () => this.setMode("browse"));
    }
    this.renderHistory(); this.setMode("browse");
  }

  private browsing() { return this.mode === "browse" && (this.dialog.open || !!this.options.mount && !this.options.mount.closest("[hidden]")); }

  private reconcile(sessions: SessionSummary[]) {
    const hosts = this.options.client()?.hosts?.();
    if (!hosts) return sessions;
    return sessions.flatMap(session => {
      if (!session.source) return [session];
      const host = hosts.find(host => deviceKey(host) === deviceKey(session.source));
      return host ? [{ ...session, source: host, ...(host.online === false ? { live: false, runtimeStatus: "offline" as const } : {}) }] : [];
    });
  }

  update(state: RuntimeState, online: boolean) {
    const reconnected = online && !this.online;
    this.state = state; this.online = online;
    const knownHosts = this.options.client()?.hosts?.(), hosts = knownHosts || [], signature = JSON.stringify(hosts);
    if (signature !== this.hostSignature) {
      this.hostSignature = signature;
      if (knownHosts) {
        this.sessions = this.reconcile(this.sessions);
        if (this.selected?.source) {
          const host = hosts.find(host => deviceKey(host) === deviceKey(this.selected!.source));
          if (host) this.selected = { ...this.selected, source: host };
          else { this.selected = undefined; this.history = undefined; this.historyRequest++; }
        }
      }
      const selected = this.computer.value || this.options.client()?.activeUrl?.();
      this.computer.replaceChildren(...hosts.map(host => new Option(`${host.name}${host.online ? "" : " (offline)"}`, host.url)));
      if (selected && hosts.some(host => host.url === selected)) this.computer.value = selected;
      else this.computer.selectedIndex = -1;
    }
    const membership = JSON.stringify(state.monitoring?.sessions.map(s => [s.key, s.monitored, s.name, s.cwd]) || []);
    const membershipChanged = membership !== this.membershipKey;
    this.membershipKey = membership;
    this.updateButtons();
    const key = `${state.session.id}:${state.main.status}:${state.connected}:${online}:${signature}:${monitoringSignature(state)}`;
    if (key !== this.statusKey) {
      this.statusKey = key;
      this.sessions = mergeSessionState(this.sessions, state);
      if (this.browsing()) { this.renderList(); this.renderHistory(); }
    }
    if (online && this.browsing() && (membershipChanged || reconnected)) void this.load();
    else if (!online && this.browsing()) this.renderList();
  }
  open(mode: "browse" | "new" = "browse") {
    this.cwd.value = this.state?.session.cwd || "";
    this.computer.value = this.options.client()?.activeUrl?.() || "";
    this.tunnel.value = this.state?.session.tunnel || "pi";
    this.name.value = ""; this.message(""); this.setMode(mode);
    if ((!this.options.mount || mode === "new") && !this.dialog.open) this.dialog.showModal();
    if (mode === "browse") void this.load();
    else this.cwd.focus();
  }
  /** Read-only history entry from the portal; never resumes or watches a CLI. */
  openHistory(session: SessionSummary) {
    this.setMode("browse");
    if (!this.dialog.open) this.dialog.showModal();
    void this.select(session);
  }
  private setMode(mode: "browse" | "new") {
    this.mode = mode; this.browsePane.hidden = !this.options.mount && mode !== "browse"; this.newPane.hidden = mode !== "new";
    if (this.options.mount) {
      if (mode === "new") this.newPane.before(this.notice);
      else this.browsePane.before(this.notice);
    }
    const buttons = this.dialog.querySelectorAll<HTMLButtonElement>(".sessions-tabs button");
    buttons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === (mode === "browse" ? 0 : 1))));
    this.updateButtons();
  }
  private message(text: string) { this.notice.textContent = text; this.notice.hidden = !text; }
  private updateButtons() {
    const busy = this.state?.main.status === "running" || this.state?.main.status === "waiting";
    const disabled = !this.online || (busy && !this.state?.monitoring) || this.mutating;
    const hosts = this.options.client()?.hosts?.();
    this.create.disabled = disabled || !!(hosts && !hosts.some(host => host.url === this.computer.value && host.online));
    this.resume.disabled = disabled || !this.selected || this.selected.source?.online === false || Boolean(this.state?.connected && this.selected.key === this.state.session.key) || !this.history;
    this.refresh.disabled = !this.online || this.loading || this.mutating;
    this.cwd.disabled = this.name.disabled = this.mutating;
    this.resume.title = busy && !this.state?.monitoring ? "Wait for the current run before switching sessions" : "";
    this.list.querySelectorAll<HTMLButtonElement>(".session-row").forEach(button => {
      button.disabled = disabled || button.dataset.hostOffline === "true";
      button.title = busy && !this.state?.monitoring ? "Wait for the current run before switching sessions" : "Open this session";
    });
    this.list.querySelectorAll<HTMLButtonElement>(".session-history-button").forEach(button => { button.disabled = !this.online || this.mutating || button.dataset.hostOffline === "true"; });
  }
  private async load() {
    const client = this.options.client();
    if (!client || !this.online) { this.message(""); this.renderList(); return; }
    const request = ++this.listRequest; this.loading = true; this.message("Loading saved sessions…"); this.updateButtons();
    try {
      const result = await client.request("/api/sessions") as { sessions: SessionSummary[]; skipped: number };
      if (request !== this.listRequest || client !== this.options.client()) return;
      this.loading = false;
      this.sessions = this.reconcile(this.state ? mergeSessionState(result.sessions, this.state) : result.sessions);
      const selectedProject = this.project.value;
      this.project.replaceChildren(new Option("All projects", ""));
      for (const cwd of [...new Set(this.sessions.map(session => session.cwd))].sort()) this.project.append(new Option(cwd, cwd));
      this.project.value = [...this.project.options].some(option => option.value === selectedProject) ? selectedProject : "";
      this.message(result.skipped ? `${result.skipped} unreadable or unsupported session files skipped.` : "");
      if (this.selected) {
        this.selected = this.sessions.find(session => session.key === this.selected!.key);
        if (!this.selected) { this.history = undefined; this.historyRequest++; }
      }
      this.renderList(); this.renderHistory();
    } catch (error) {
      if (request === this.listRequest && client === this.options.client()) this.message(error instanceof Error ? error.message : "Could not load sessions");
    } finally { if (request === this.listRequest && client === this.options.client()) { this.loading = false; if (!this.sessions.length && this.browsing()) this.renderList(); this.updateButtons(); } }
  }
  private renderList() {
    const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
    this.list.replaceChildren();
    const hosts = this.options.client()?.hosts?.() || this.state?.hosts || [];
    const all = sessionGroups(this.sessions, hosts);
    this.selectedDevices = this.selectedDevices.filter(key => all.some(group => group.key === key));
    this.filters.update(this.scope, this.selectedDevices, all);
    const groups = sessionGroups(this.sessions, hosts, { devices: this.selectedDevices, search: this.search.value, project: this.project.value, scope: this.scope });
    if (!groups.length) {
      this.list.append(element("p", !hosts.length && !this.online ? "Connect a computer to see its sessions." : this.loading ? "Loading sessions…" : "No matching sessions.", "caption"));
      if (!hosts.length && !this.online && this.options.connect) {
        const connect = element("button", "Add computer", "primary"); connect.type = "button"; connect.onclick = this.options.connect; this.list.append(connect);
      }
      return;
    }
    for (const group of groups) {
      const device = element("details", undefined, "session-device"), summary = element("summary");
      device.open = !!this.search.value.trim() || !this.collapsed.has(group.key);
      const name = element("strong", group.name), count = element("span", `${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"} · ${group.online ? "Online" : "Offline"}`, "caption");
      summary.append(name, count); device.append(summary);
      const items = element("div", undefined, "session-device-items"); device.append(items); this.list.append(device);
      const draw = () => {
        items.replaceChildren();
        if (!device.open) return;
        if (!group.sessions.length) items.append(element("p", group.online ? "No sessions match this view." : "Reconnect this device to load sessions. Watch is retained.", "caption"));
        const limit = this.limits.get(group.key) || 8;
        for (const session of group.sessions.slice(0, limit)) {
        const button = element("button", undefined, "session-row"); button.type = "button";
        const active = Boolean(this.state?.connected && session.key === this.state.session.key);
        button.dataset.focusKey = session.key;
        button.setAttribute("aria-pressed", String(active));
        button.append(element("strong", sessionName(session)));
        const status = !group.online ? "Offline" : session.live ? session.runtimeStatus : "Saved";
        const meta = element("small", `${(session.tunnel || "pi").toUpperCase()} · ${status} · ${sessionAge(session.updatedAt)}`, "session-meta");
        if (active) meta.prepend(element("span", "Current · ", "session-current"));
        button.append(meta); button.dataset.hostOffline = String(!group.online);
        const project = element("small", session.cwd.split(/[\\/]/).filter(Boolean).at(-1) || session.cwd, "session-project-path");
        project.title = session.cwd; button.append(project);
        button.onclick = () => {
          if (active) { this.dialog.close(); this.options.opened?.(); }
          else void this.mutate("/api/session/resume", { key: session.key }, "Session opened. Enter your next task.");
        };
        const history = element("button", "History", "text-button session-history-button"); history.type = "button";
        history.dataset.hostOffline = String(session.source?.online === false);
        history.setAttribute("aria-label", `View history: ${sessionName(session)}`);
        history.onclick = () => void this.select(session);
        const actions = element("div", undefined, "session-entry-actions"); if (!this.options.mount) actions.append(history);
        if (this.state?.monitoring) {
          const watch = element("button", session.monitored ? "Watching" : "Watch", "text-button session-watch"); watch.type = "button";
          watch.setAttribute("aria-pressed", String(!!session.monitored)); watch.setAttribute("aria-label", `${session.monitored ? "Unwatch" : "Watch"}: ${sessionName(session)}`);
          watch.title = session.monitored ? "Stop watching. The terminal keeps running." : "Watch this session on G2"; watch.dataset.focusKey = "watch:" + session.key;
          watch.disabled = this.mutating || !this.online || !group.online;
          watch.onclick = () => void this.monitor(session);
          const window = element("button", "Open terminal ↗", "text-button"); window.type = "button";
          window.disabled = this.mutating || !this.online || session.source?.online === false;
          window.onclick = () => void this.openWindow(session);
          actions.append(watch); if (!this.options.mount) actions.append(window);
        }
        const row = element("div", undefined, "session-entry"); row.append(button, actions); items.append(row);
        }
        if (group.sessions.length > limit) {
          const more = element("button", `Show more (${group.sessions.length - limit})`, "text-button session-more"); more.type = "button";
          more.onclick = () => { this.limits.set(group.key, limit + 16); draw(); this.updateButtons(); }; items.append(more);
        }
      };
      draw();
      let renderedOpen = device.open;
      device.ontoggle = () => {
        if (!device.isConnected || device.open === renderedOpen) return;
        renderedOpen = device.open;
        if (device.open) this.collapsed.delete(group.key); else this.collapsed.add(group.key);
        draw(); this.updateButtons();
      };
    }
    this.updateButtons();
    if (focused) [...this.list.querySelectorAll<HTMLButtonElement>("button")].find(button => button.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }
  private async select(session: SessionSummary) {
    const client = this.options.client();
    if (!client || !this.online || session.source?.online === false) { this.message("This computer is offline. Reconnect to read its history."); return; }
    this.selected = session; this.history = undefined;
    const request = ++this.historyRequest; this.renderList(); this.renderHistory();
    try {
      const result = await client.request(`/api/sessions/${encodeURIComponent(session.key)}/history`) as SessionHistory;
      if (request !== this.historyRequest || client !== this.options.client() || this.selected?.key !== session.key || this.selected.source?.online === false) return;
      this.history = result; this.renderHistory();
    } catch (error) {
      if (request === this.historyRequest && client === this.options.client()) { this.message(error instanceof Error ? error.message : "Could not read history"); }
    }
  }
  private renderHistory() {
    if (this.options.mount) return;
    this.historyView.replaceChildren();
    if (!this.selected) {
      this.historyView.append(element("h3", "PICK UP WHERE YOU LEFT OFF"), element("p", "Tap a session to open it immediately. Use History to preview a conversation first.", "caption")); return;
    }
    this.historyView.append(element("h3", sessionName(this.selected)), element("p", this.selected.cwd, "caption"));
    const active = Boolean(this.state?.connected && this.selected.key === this.state.session.key);
    this.resume.textContent = active ? "CURRENT SESSION" : "OPEN SESSION →";
    this.resume.type = "button"; this.resume.onclick = () => {
      if (this.selected) void this.mutate("/api/session/resume", { key: this.selected.key }, "Session ready. Continue in the terminal.");
    };
    this.historyView.append(this.resume, element("p", this.state?.nativeTerminals
      ? "An open connected terminal is monitored directly. Otherwise its original session opens in a new terminal."
      : active ? "This is the selected native session." : "Open the original session on its source computer. An already connected terminal is reused.", "caption"));
    const messages = element("div", undefined, "history-messages");
    if (!this.history) messages.append(element("p", this.selected.source?.online === false ? "Reconnect this computer to read its history." : "Loading history…", "caption"));
    else {
      if (this.history.truncated) messages.append(element("p", "Showing recent history. The agent keeps the complete conversation.", "caption"));
      if (!this.history.messages.length) messages.append(element("p", "No conversation messages in this session yet.", "caption"));
      for (const message of this.history.messages) {
        const entry = element("article", undefined, "history-message");
        entry.append(element("strong", message.role.toUpperCase()), element("pre", message.text)); messages.append(entry);
      }
    }
    this.historyView.append(messages); this.updateButtons();
  }
  private async mutate(path: string, data: unknown, success: string) {
    if (!this.options.client() || !this.online || this.mutating || (!this.state?.monitoring && (this.state?.main.status === "running" || this.state?.main.status === "waiting"))) return;
    this.mutating = true; this.options.busy(true); this.message("Opening session…"); this.updateButtons();
    try {
      await this.options.client()!.request(path, data);
      this.historyRequest++; this.history = undefined; this.selected = undefined;
      this.dialog.close(); this.options.changed(success); this.options.opened?.();
    } catch (error) { this.message(error instanceof Error ? error.message : "Session change failed"); }
    finally { this.mutating = false; this.options.busy(false); this.updateButtons(); }
  }
  private async monitor(session: SessionSummary) {
    if (this.mutating) return;
    this.mutating = true; this.options.busy(true); this.renderList();
    try {
      await this.options.client()!.request(`/api/runtime/${session.key}/monitor`, { monitored: !session.monitored });
      await this.load();
      this.options.changed(session.monitored ? "Unwatched. The terminal and its running task continue." : "Session is now watched.");
    } catch (error) { this.message(error instanceof Error ? error.message : "Could not update monitoring"); }
    finally { this.mutating = false; this.options.busy(false); this.renderList(); }
  }
  private async openWindow(session: SessionSummary) {
    if (this.mutating) return;
    this.mutating = true; this.options.busy(true); this.renderList();
    try {
      await this.options.client()!.request(`/api/runtime/${session.key}/terminal`, {});
      await this.load(); this.options.changed("Session opened in the native terminal.");
    } catch (error) { this.message(error instanceof Error ? error.message : "Could not open terminal"); }
    finally { this.mutating = false; this.options.busy(false); this.renderList(); }
  }
}
