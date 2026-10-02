export type HubView = "sessions" | "conversation" | "glasses";

/** Phone navigation reuses existing panels; the glasses' own page is independent. */
export class HubShell {
  readonly sessions = document.createElement("div");
  view: HubView = "sessions";
  private panels = new Map<HubView, HTMLElement>();
  private buttons = new Map<HubView, HTMLButtonElement>();
  constructor(changed: (view: HubView) => void) {
    document.body.classList.add("hub-mode");
    const main = document.querySelector("main")!;
    const nav = document.createElement("nav"); nav.className = "hub-nav"; nav.setAttribute("aria-label", "Hub pages");
    const contents = document.createElement("div"); contents.className = "hub-content";
    for (const [key, title] of [["sessions", "Sessions"], ["conversation", "Conversation"], ["glasses", "G2"]] as const) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = title;
      button.setAttribute("aria-controls", `hub-${key}`);
      button.onclick = () => { this.show(key); changed(key); };
      const panel = document.createElement("section"); panel.id = `hub-${key}`; panel.setAttribute("aria-label", title);
      this.panels.set(key, panel); this.buttons.set(key, button); nav.append(button); contents.append(panel);
    }
    this.sessions.className = "hub-session-manager";
    this.sessions.innerHTML = '<p class="caption">Loading sessions…</p>';
    this.panels.get("sessions")!.append(this.sessions);
    const selected = document.createElement("div"); selected.className = "hub-selected-session";
    selected.append(document.getElementById("session-label")!);
    const switchButton = document.createElement("button"); switchButton.type = "button"; switchButton.className = "text-button"; switchButton.textContent = "Switch";
    switchButton.onclick = () => { this.show("sessions"); changed("sessions"); }; selected.append(switchButton);
    const terminal = document.querySelector<HTMLElement>(".terminal-panel")!;
    terminal.querySelector("h2")!.textContent = "Conversation";
    const details = document.createElement("details"); details.className = "hub-runtime";
    const summary = document.createElement("summary"); summary.textContent = "Session details";
    details.append(summary, document.querySelector(".details-card")!);
    this.panels.get("conversation")!.append(selected, terminal, details);
    this.panels.get("glasses")!.append(document.querySelector(".glasses-card")!);
    document.querySelector<HTMLElement>(".page-heading")!.hidden = true;
    document.querySelector<HTMLElement>(".workspace")!.hidden = true;
    main.prepend(nav); document.getElementById("notice")!.after(contents);
    const glance = document.querySelector<HTMLElement>(".glance-details")!;
    const disclosure = document.createElement("details"); disclosure.className = "hub-glance";
    const glanceSummary = document.createElement("summary"); glanceSummary.textContent = "Glance notifications";
    glance.before(disclosure); disclosure.append(glanceSummary, glance);
    this.show("sessions");
  }
  show(view: HubView) {
    this.view = view;
    for (const [key, panel] of this.panels) panel.hidden = key !== view;
    for (const [key, button] of this.buttons) button.setAttribute("aria-pressed", String(key === view));
  }
}
