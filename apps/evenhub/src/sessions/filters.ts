import type { SessionGroup, SessionScope } from "./groups.js";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
let sequence = 0;
const scopeLabels: Record<SessionScope, string> = { all: "All", watched: "Watched", running: "Running" };
function connectionLabel(group: SessionGroup) {
  if (group.online) return "";
  if (group.connectionState === "key-rejected") return " · key rejected";
  if (group.connectionState === "connecting") return " · connecting";
  if (group.connectionState === "retrying") return ` · retrying${group.retryAttempt ? " " + group.retryAttempt : ""}`;
  return " · offline";
}

/** Empty device selections mean all; unchecking the last explicit device returns to all. */
export class SessionFilterDropdowns {
  readonly element = element("div", "", "session-dropdown-filters");
  private status = element("details", "", "session-dropdown session-status-dropdown");
  private devices = element("details", "", "session-dropdown session-devices-dropdown");
  private statusSummary = element("summary");
  private devicesSummary = element("summary");
  private deviceOptions = element("div", "", "session-dropdown-options");
  private selectedDevices: readonly string[] = [];
  private deviceSignature = "";
  private statusInputs = new Map<SessionScope, HTMLInputElement>();
  constructor(private changed: { scope: (value: SessionScope) => void; devices: (value: string[]) => void }) {
    const statusOptions = element("div", "", "session-dropdown-options");
    statusOptions.setAttribute("role", "radiogroup"); statusOptions.setAttribute("aria-label", "Session status");
    const name = `session-scope-${++sequence}`;
    for (const scope of ["all", "watched", "running"] as const) {
      const label = element("label", "", "session-dropdown-option"), input = element("input");
      input.type = "radio"; input.name = name; input.value = scope; input.dataset.scope = scope;
      input.setAttribute("aria-label", scopeLabels[scope]);
      input.onchange = () => { if (input.checked) { this.status.open = false; this.statusSummary.focus(); changed.scope(scope); } };
      label.append(input, element("span", scopeLabels[scope])); statusOptions.append(label); this.statusInputs.set(scope, input);
    }
    this.status.append(this.statusSummary, statusOptions); this.devices.append(this.devicesSummary, this.deviceOptions);
    this.deviceOptions.setAttribute("role", "group"); this.deviceOptions.setAttribute("aria-label", "Choose devices");
    for (const [menu, summary, other] of [[this.status, this.statusSummary, this.devices], [this.devices, this.devicesSummary, this.status]] as const) {
      menu.ontoggle = () => { summary.setAttribute("aria-expanded", String(menu.open)); if (menu.open) other.open = false; };
      menu.onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); menu.open = false; summary.focus(); } };
    }
    const statusField = element("div", "", "session-dropdown-field"), devicesField = element("div", "", "session-dropdown-field");
    statusField.append(element("span", "STATUS", "session-dropdown-label"), this.status);
    devicesField.append(element("span", "DEVICES", "session-dropdown-label"), this.devices);
    this.element.append(statusField, devicesField);
  }
  update(scope: SessionScope, devices: readonly string[], groups: SessionGroup[]) {
    this.selectedDevices = devices;
    this.statusSummary.textContent = scopeLabels[scope]; this.statusSummary.setAttribute("aria-label", `Session status: ${scopeLabels[scope]}`);
    this.statusSummary.setAttribute("aria-expanded", String(this.status.open));
    for (const [value, input] of this.statusInputs) input.checked = value === scope;
    const names = groups.filter(group => devices.includes(group.key)).map(group => group.name + connectionLabel(group));
    this.devicesSummary.textContent = names.length === 0 ? "All devices" : names.length === 1 ? names[0] : `${names.length} devices`;
    this.devicesSummary.title = names.length ? names.join(", ") : "Show sessions across all saved devices";
    this.devicesSummary.setAttribute("aria-label", `Devices: ${this.devicesSummary.title}`);
    this.devicesSummary.setAttribute("aria-expanded", String(this.devices.open));
    const signature = JSON.stringify(groups.map(group => [group.key, group.name, group.online, group.connectionState, group.retryAttempt, group.sessions.length]));
    if (signature !== this.deviceSignature) {
      this.deviceSignature = signature; this.deviceOptions.replaceChildren();
      for (const [key, title] of [["", "All devices"], ...groups.map(group => [group.key, `${group.name}${connectionLabel(group)} (${group.sessions.length})`])]) {
        const label = element("label", "", "session-dropdown-option"), input = element("input");
        input.type = "checkbox"; input.dataset.device = key; label.title = key || "Clear selections and show all devices";
        input.setAttribute("aria-label", title);
        input.onchange = () => {
          const next = new Set(this.selectedDevices);
          if (!key) next.clear(); else if (input.checked) next.add(key); else next.delete(key);
          this.changed.devices([...next]);
        };
        label.append(input, element("span", title)); this.deviceOptions.append(label);
      }
    }
    this.deviceOptions.querySelectorAll<HTMLInputElement>("input").forEach(input => {
      input.checked = input.dataset.device ? devices.includes(input.dataset.device) : devices.length === 0;
    });
  }
}
