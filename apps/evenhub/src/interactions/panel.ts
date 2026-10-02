import type { RuntimeState } from "../../../../packages/cockpit-state/types.js";
import type { InteractionAnswer } from "../../../../packages/cockpit-state/interactions.js";

/** Plain text only: CLI output never becomes HTML, script, or an executable button. */
export class InteractionPanel {
  readonly element = document.createElement("section");
  private identity = "";
  private busy = false;
  private ready = false;
  constructor(private submit: (session: string, answer: InteractionAnswer) => Promise<void>) {
    this.element.className = "interaction-panel"; this.element.hidden = true;
    this.element.setAttribute("aria-live", "polite");
  }
  update(state: RuntimeState, online: boolean) {
    const request = state.interactions?.[0], key = state.session.key;
    this.ready = online && state.connected;
    const identity = key + ":" + (request?.id || "");
    if (identity === this.identity) {
      this.element.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.disabled = !this.ready || this.busy); return;
    }
    this.identity = identity; this.busy = false; this.element.replaceChildren(); this.element.hidden = !request || !key;
    if (!request || !key) return;
    const title = document.createElement("h3"); title.textContent = request.title; this.element.append(title);
    if (request.detail) { const detail = document.createElement("pre"); detail.textContent = request.detail; this.element.append(detail); }
    const form = document.createElement("form"), values = new Map<string, () => string>();
    for (const q of request.questions) {
      const group = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = q.text; group.append(legend);
      let selected: string | undefined, text: HTMLInputElement | undefined;
      for (const option of q.options) {
        const label = document.createElement("label"), radio = document.createElement("input");
        radio.type = "radio"; radio.name = request.id + ":" + q.id;
        const span = document.createElement("span"); span.textContent = option.label + (option.description ? " — " + option.description : "");
        radio.onchange = () => { selected = option.id; if (text) text.value = ""; };
        label.append(radio, span); group.append(label);
      }
      if (q.allowText) {
        text = document.createElement("input"); text.type = q.secret ? "password" : "text";
        text.maxLength = 8000; text.placeholder = q.options.length ? "Or enter your answer" : "Enter your answer";
        text.setAttribute("aria-label", q.text); text.autocomplete = "off";
        text.oninput = () => { selected = undefined; group.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(r => r.checked = false); };
        group.append(text);
      }
      values.set(q.id, () => selected ?? text?.value.trim() ?? ""); form.append(group);
    }
    const message = document.createElement("p"); message.className = "caption";
    const send = document.createElement("button"); send.type = "submit"; send.textContent = "Confirm selection";
    send.disabled = !this.ready; form.append(send);
    const deliver = async (cancel = false) => {
      if (this.busy || !this.ready || this.identity !== identity) return;
      const answers = Object.fromEntries([...values].map(([id, read]) => [id, read()]));
      if (!cancel && Object.values(answers).some(value => !value)) { message.textContent = "Answer every question first."; return; }
      this.busy = true; form.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.disabled = true);
      try { await this.submit(key, { requestId: request.id, answers, ...(cancel ? { cancel: true } : {}) });
        if (this.identity === identity) message.textContent = "Response submitted.";
      } catch (error) { if (this.identity === identity) message.textContent = error instanceof Error ? error.message : "Not confirmed. Check Terminal before retrying."; }
      // A submitted or unconfirmed response is not replayed. The state stream supplies the next request.
    };
    form.onsubmit = event => { event.preventDefault(); void deliver(); };
    if (request.cancelable) { const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
      cancel.className = "subtle"; cancel.disabled = !this.ready; cancel.onclick = () => { void deliver(true); }; form.append(cancel); }
    form.append(message); this.element.append(form);
  }
}
