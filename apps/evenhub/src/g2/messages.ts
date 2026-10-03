import type { G2Message, G2Messages } from "../../../../packages/cockpit-state/g2-reply.js";
import { readableText } from "./text.js";
import { getTextWidth } from "@evenrealities/pretext";

export interface MessageRow { key: string; label: string }
export const LIST_ROW_WIDTH = 560;
export const LIST_TEXT_INSET = 8;
export const LIST_TEXT_WIDTH = LIST_ROW_WIDTH - 2 * LIST_TEXT_INSET;
/** Use the documented 64-character limit and actual glyph width, not a byte budget. */
export function listLabel(text: string, prefix = "", suffix = "", maxBytes?: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  const fits = (part: string) => {
    const label = prefix + part + suffix;
    return label.length <= 64 && getTextWidth(label) <= LIST_TEXT_WIDTH &&
      (maxBytes === undefined || utf8.encode(label).length <= maxBytes);
  };
  if (fits(value)) return prefix + value + suffix;
  let clipped = "";
  for (const char of value) { if (!fits(clipped + char + "...")) break; clipped += char; }
  // Do not chop an English word at the row boundary unless it is the entire row.
  if (/[A-Za-z0-9_]/.test(value[clipped.length] || "") && /\s/.test(clipped)) clipped = clipped.replace(/[A-Za-z0-9_'-]+$/, "");
  return prefix + clipped.trimEnd() + "..." + suffix;
}
export function messageLabel(message: G2Message, compact = false): string {
  const text = readableText(message.text.slice(0, 600));
  const maxBytes = compact ? 63 : undefined;
  // Fullwidth spaces survive native leading-space trimming. Their measured
  // 40px indent is about two arrow widths and stays inside every row budget.
  return listLabel(text, message.role === "assistant" ? "\u3000\u3000← " : "→ ", "", maxBytes);
}

export const NATIVE_TEXT_BYTES = 900;
const utf8 = new TextEncoder();
/** Stay below both the documented character limit and the simulator's 999-byte create limit. */
export function nativeTextPrefix(text: string): string {
  let bytes = 0, prefix = "";
  for (const char of text) {
    const size = utf8.encode(char).length;
    if (bytes + size > NATIVE_TEXT_BYTES) break;
    prefix += char; bytes += size;
  }
  return prefix || " ";
}
/** Every native page starts with its full part, never an empty page awaiting a second BLE write. */
export function messageParts(text: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = start + nativeTextPrefix(text.slice(start)).length;
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n", end - 1);
      if (paragraph > start + (end - start) / 2) end = paragraph + 1;
    }
    parts.push(text.slice(start, end)); start = end;
  }
  return parts.length ? parts : [" "];
}

export class MessageBrowser {
  private live: G2Messages = { messages: [], limited: false };
  private frozen?: G2Messages;
  private liveActivity?: string;
  private frozenActivity?: { label?: string };
  private activityFocus = false;
  selected = 0;
  detail?: { message: G2Message; parts: string[]; part: number; revision: number };
  private revision = 0;
  private cachedRows?: { history: G2Messages; activity?: string; compact: boolean; rows: MessageRow[] };
  reset() { this.selected = 0; this.activityFocus = false; this.frozen = undefined; this.frozenActivity = undefined; this.detail = undefined; }
  update(history: G2Messages) {
    this.live = history;
    // Startup can mount the input row before connection/history arrives. There
    // is no message focus to preserve yet: hydrate it without requiring Refresh.
    if (this.frozen && !this.frozen.messages.length && history.messages.length && this.inputSelected) {
      this.frozen = undefined; this.frozenActivity = undefined;
    }
  }
  updateActivity(label?: string) { this.liveActivity = label; }
  get history() { return this.frozen || this.live; }
  get messages() { return this.history.messages; }
  get inputSelected() { return this.selected === 0 && !this.activityFocus; }
  get activitySelected() { return this.activityFocus; }
  get changed() {
    return !!this.frozen && (this.frozen.limited !== this.live.limited || this.frozen.messages.length !== this.live.messages.length || this.frozen.messages.some((message, i) =>
      message.id !== this.live.messages[i]?.id || message.text !== this.live.messages[i]?.text));
  }
  hold() {
    if (this.frozen) return;
    this.frozen = this.live; this.frozenActivity = { label: this.liveActivity };
  }
  refresh() {
    const activityChanged = this.frozenActivity && this.frozenActivity.label !== this.liveActivity;
    if (this.detail || !this.inputSelected || !this.changed && !activityChanged) return false;
    this.frozen = undefined; this.frozenActivity = undefined;
    return true;
  }
  scroll(direction: number) {
    if (this.detail) return;
    this.hold();
    this.activityFocus = false;
    this.selected = Math.max(0, Math.min(this.messages.length, this.selected + direction));
  }
  selectInput() { this.reset(); }
  selectActivity() { this.hold(); this.activityFocus = true; }
  selectedRow(rows: readonly { key?: string }[]) {
    const key = this.activityFocus ? "working-agents" : this.selected === 0 ? "input" : this.messages[this.selected - 1]?.id;
    return rows.findIndex(row => row.key === key);
  }
  open() {
    if (this.activityFocus) return;
    const message = this.messages[this.selected - 1];
    if (!message) return;
    this.hold();
    this.detail = { message, parts: messageParts(readableText(message.text) || "No text to display. View this message on your phone or computer."), part: 0, revision: ++this.revision };
  }
  back() { this.detail = undefined; }
  part(direction: number) {
    if (!this.detail) return;
    this.detail.part = Math.max(0, Math.min(this.detail.parts.length - 1, this.detail.part + direction));
  }
  rows(compact = false): MessageRow[] {
    const activity = this.frozenActivity ? this.frozenActivity.label : this.liveActivity;
    if (this.cachedRows?.history === this.history && this.cachedRows.activity === activity && this.cachedRows.compact === compact) return this.cachedRows.rows;
    const rows = [{ key: "input", label: "New prompt" }, ...(activity ? [{ key: "working-agents", label: activity }] : []),
      ...this.messages.map(message => ({ key: message.id, label: messageLabel(message, compact) }))];
    this.cachedRows = { history: this.history, activity, compact, rows };
    return rows;
  }
}
