import type { RuntimeState } from "../../../../packages/cockpit-state/types.js";
import { sessionLabel } from "../../../../packages/cockpit-state/selectors.js";

export interface SelectedInputNeeded { id: string; key: string; mode: "remote" | "terminal" }
/** A wait alone can also mean a background tool; only verified input requests qualify. */
export function selectedInputNeeded(state: RuntimeState, now = Date.now()): SelectedInputNeeded | undefined {
  const key = state.session.key;
  if (!key || !state.connected) return;
  const request = state.interactions?.[0];
  if (request && ["approval", "question"].includes(request.kind) && request.expiresAt > now)
    return { id: request.id, key, mode: "remote" };
  const attention = state.attention?.find(item => !!item.id && ["approval", "question", "terminal-input"].includes(item.kind) &&
    (item.expiresAt === undefined || Number.isFinite(item.expiresAt) && item.expiresAt > now));
  if (attention) return { id: attention.id, key, mode: "terminal" };
}

/** Navigation only: the request's existing panel remains responsible for answering. */
export class InputNeededNotice {
  readonly element = document.createElement("section");
  private message = document.createElement("span");
  private button = document.createElement("button");
  private current?: SelectedInputNeeded;
  private signature = "";
  constructor(openConversation: (key: string) => void) {
    this.element.className = "input-needed"; this.element.hidden = true;
    this.element.setAttribute("role", "status");
    this.button.type = "button"; this.button.className = "text-button"; this.button.textContent = "Answer →";
    this.button.onclick = () => {
      if (!this.element.hidden && this.current?.mode === "remote") openConversation(this.current.key);
    };
    this.element.append(this.message, this.button);
  }
  update(state: RuntimeState, online: boolean, now = Date.now()) {
    this.current = online ? selectedInputNeeded(state, now) : undefined;
    const label = this.current ? sessionLabel(state) : "";
    const signature = JSON.stringify([this.current, label]);
    if (signature === this.signature) return;
    this.signature = signature; this.element.hidden = !this.current;
    if (!this.current) return;
    this.message.textContent = `Needs input · ${label}${this.current.mode === "terminal" ? " · Answer in original terminal" : ""}`;
    this.button.hidden = this.current.mode !== "remote";
  }
}
