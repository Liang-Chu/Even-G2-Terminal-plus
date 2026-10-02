import type { RuntimeState } from "./types.js";

export const G2_SOURCE_TAG = "[even-pilot:source=g2]";
export const G2_SUMMARY_OPEN = "<g2-summary>";
export const G2_SUMMARY_CLOSE = "</g2-summary>";
export const G2_HISTORY_LIMIT = 10;
export const G2_HISTORY_NOTICE = "Older messages: view on your phone or computer.";

/** The user explicitly requested full terminal output plus a separate glasses summary. */
export function g2Prompt(text: string): string {
  return `${G2_SOURCE_TAG}\nThis prompt was sent from Even G2 glasses. Complete the task normally and keep the full response for the desktop terminal. At the end of your final reply, append a separate plain-text section exactly like this (do not put it inside a code fence):\n${G2_SUMMARY_OPEN}\nA concise summary in the user's language: result, any blocker, and next action. Aim for 1–4 short lines, at most 300 characters. Preserve important commands or decisions.\n${G2_SUMMARY_CLOSE}\nDo not put these markers in intermediate progress or tool output.\n\nUser prompt:\n${text}`;
}

/** Accept a streaming summary, but never show a half-written delimiter. */
export function g2Summary(text: string): string | undefined {
  const start = text.lastIndexOf(G2_SUMMARY_OPEN);
  if (start < 0) return;
  const rest = text.slice(start + G2_SUMMARY_OPEN.length);
  const end = rest.indexOf(G2_SUMMARY_CLOSE);
  if (end >= 0) return rest.slice(0, end).trim();
  for (let length = G2_SUMMARY_CLOSE.length - 1; length > 0; length--) {
    if (rest.endsWith(G2_SUMMARY_CLOSE.slice(0, length))) return rest.slice(0, -length).trim();
  }
  return rest.trim();
}

export interface G2Message { id: string; role: "user" | "assistant"; text: string }
export interface G2Messages { messages: G2Message[]; limited: boolean }

/** Keep complete visible messages; the native list label is a separate presentation. */
export function glassesMessages(state: RuntimeState): G2Messages {
  const turns: { prompt?: G2Message; tagged: boolean; replies: G2Message[] }[] = [];
  let turn: (typeof turns)[number] = { tagged: false, replies: [] };
  for (const [index, entry] of state.transcript.entries()) {
    const id = `${entry.role}:${entry.id ?? index}:${entry.at ?? 0}`;
    if (entry.role === "user") {
      if (turn.prompt || turn.replies.length) turns.push(turn);
      const tagged = entry.text.startsWith(G2_SOURCE_TAG);
      const marker = "\n\nUser prompt:\n", start = entry.text.indexOf(marker);
      turn = { tagged, prompt: { id, role: "user", text: tagged ? start >= 0 ? entry.text.slice(start + marker.length) : "G2 prompt" : entry.text }, replies: [] };
    } else if (entry.role === "assistant" && entry.text) turn.replies.push({ id, role: "assistant", text: entry.text });
  }
  const current = state.currentAssistantText;
  if (current && (state.assistantOpen || !state.transcript.length) && turn.replies.at(-1)?.text !== current)
    turn.replies.push({ id: `stream:${turn.prompt?.id || "root"}:${turn.replies.at(-1)?.id || "first"}`, role: "assistant", text: current });
  if (turn.prompt || turn.replies.length) turns.push(turn);
  const visible: G2Message[] = [];
  let index = turns.length - 1;
  for (; index >= 0 && visible.length <= G2_HISTORY_LIMIT; index--) {
    const item = turns[index];
    const summarized = item.replies.map(reply => ({ ...reply, summary: g2Summary(reply.text) }))
      .filter(reply => reply.summary !== undefined).at(-1);
    const replies: G2Message[] = summarized ? summarized.summary ? [{ id: summarized.id, role: "assistant", text: summarized.summary }] : [] : item.tagged ? [] : item.replies;
    const blocks: G2Message[] = item.prompt?.text ? [{ ...item.prompt }] : [];
    if (item.tagged && item.prompt && !replies.length) {
      const running = index === turns.length - 1 && ["running", "waiting"].includes(state.main.status);
      const notice = running ? "" : "▶ No G2 summary returned. Read the full reply in Terminal.";
      if (notice && blocks.length) blocks[0].text += "\n\n" + notice;
    }
    blocks.push(...replies);
    visible.unshift(...blocks);
  }
  return { messages: visible.slice(-G2_HISTORY_LIMIT), limited: visible.length > G2_HISTORY_LIMIT || index >= 0 };
}
