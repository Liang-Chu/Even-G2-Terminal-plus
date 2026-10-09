import type { InputAttention } from "../cockpit-state/types.js";
import { createHash } from "node:crypto";

const names = new Set(["request_user_input", "request_user_input_async"]);
const identifier = /^[a-zA-Z0-9_-]{1,256}$/;
const MAX_RECORDS = 128, MAX_QUESTIONS = 16, MAX_TEXT = 64_000;
interface Request {
  id: string; name: string; count: number; answered: number[]; createdAt: number; turnId?: string; baseline?: true; questionIds?: string[];
}
export interface CodexInputSnapshot { version: 1; requests: Request[] }
export type CodexInputRecord = { type: "request"; request: Request } |
  { type: "reply"; answers: { name: string; id: string; index: number }[] } |
  { type: "output"; id: string; failed: boolean; questionIds: string[] };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const questionId = (value: string) => createHash("sha256").update(value).digest("hex");
const validQuestionId = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 256;
function toolName(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const name = value.startsWith("functions.") ? value.slice("functions.".length) : value;
  return names.has(name) ? name : undefined;
}
function replies(text: unknown): Extract<CodexInputRecord, { type: "reply" }> | undefined {
  if (typeof text !== "string" || text.length > MAX_TEXT) return;
  // Only the native UI's complete reply envelope qualifies, not quoted prose.
  const match = /^\s*<send_user_message_question_reply>\s*(\[[\s\S]*\])\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return;
  let value: unknown; try { value = JSON.parse(match[1]); } catch { return; }
  if (!Array.isArray(value) || value.length > MAX_RECORDS) return;
  const answers: Extract<CodexInputRecord, { type: "reply" }>["answers"] = [];
  for (const answer of value) {
    if (!object(answer) || typeof answer.answer !== "string" || typeof answer.questionItemId !== "string" || answer.questionItemId.length > 512) continue;
    let tuple: unknown; try { tuple = JSON.parse(answer.questionItemId); } catch { continue; }
    if (!Array.isArray(tuple) || tuple.length !== 3 || !names.has(tuple[0]) || typeof tuple[1] !== "string" || !identifier.test(tuple[1]) ||
      !Number.isSafeInteger(tuple[2]) || tuple[2] < 0 || tuple[2] >= MAX_QUESTIONS) continue;
    answers.push({ name: tuple[0], id: tuple[1], index: tuple[2] });
  }
  return answers.length ? { type: "reply", answers } : undefined;
}

/** Extract IDs/counts only; question text, options and answer values are discarded. */
export function codexInputRecord(row: unknown, turnId?: string, baseline = false): CodexInputRecord | undefined {
  if (!object(row) || !object(row.payload)) return;
  const payload = row.payload;
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at) || at < 0 || at > Date.now() + 60_000) return;
  if (row.type === "response_item" && payload.type === "function_call") {
    const name = toolName(payload.name);
    if (!name || typeof payload.call_id !== "string" || !identifier.test(payload.call_id)) return;
    let args: unknown = payload.arguments;
    if (typeof args === "string") {
      if (args.length > MAX_TEXT) return;
      try { args = JSON.parse(args); } catch { return; }
    }
    if (!object(args) || !Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > MAX_QUESTIONS ||
      args.questions.some(question => !object(question) || typeof question.question !== "string" || !question.question.trim())) return;
    const ids = args.questions.every(question => validQuestionId(question.id))
      ? args.questions.map(question => questionId(question.id)) : undefined;
    return { type: "request", request: { id: payload.call_id, name, count: args.questions.length, answered: [], createdAt: at,
      ...(ids && new Set(ids).size === ids.length ? { questionIds: ids } : {}),
      ...(turnId && identifier.test(turnId) ? { turnId } : {}), ...(baseline ? { baseline: true } : {}) } };
  }
  if (row.type === "response_item" && payload.type === "function_call_output" &&
    typeof payload.call_id === "string" && identifier.test(payload.call_id)) {
    let output: unknown = payload.output;
    if (typeof output === "string") {
      if (output.length > MAX_TEXT) return;
      try { output = JSON.parse(output); } catch { return; }
    }
    if (!object(output)) return;
    const failed = output.accepted === false || output.isError === true ||
      typeof output.error === "string" && !!output.error.trim() || object(output.error) ||
      ["failed", "error", "timeout"].includes(output.status);
    const ids = object(output.answers) ? Object.entries(output.answers).filter(([id, answer]) =>
      validQuestionId(id) && object(answer) && Array.isArray(answer.answers) && answer.answers.length > 0 &&
      answer.answers.every((value: unknown) => typeof value === "string")).slice(0, MAX_QUESTIONS).map(([id]) => questionId(id)) : [];
    return { type: "output", id: payload.call_id, failed, questionIds: ids };
  }
  const message = row.type === "response_item" && payload.type === "message" && payload.role === "user" ? payload :
    row.type === "event_msg" && payload.type === "item_completed" && payload.item?.type === "UserMessage" ? payload.item : undefined;
  if (!message || !Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (!object(part) || !["text", "input_text"].includes(part.type)) continue;
    const reply = replies(part.text); if (reply) return reply;
  }
}

/** Exact pending UI questions are independent of agent/tool lifecycle and counts. */
export class CodexInputTracker {
  private requests = new Map<string, Request>();
  constructor(snapshot?: unknown) {
    if (!object(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.requests) || snapshot.requests.length > MAX_RECORDS) return;
    const checked: Request[] = [];
    for (const request of snapshot.requests) {
      if (!object(request) || typeof request.id !== "string" || !identifier.test(request.id) || !names.has(request.name) ||
        checked.some(previous => previous.id === request.id) ||
        !Number.isSafeInteger(request.count) || request.count < 1 || request.count > MAX_QUESTIONS ||
        !Number.isFinite(request.createdAt) || request.createdAt < 0 || request.createdAt > Date.now() + 60_000 ||
        !Array.isArray(request.answered) || request.answered.length > request.count ||
        request.answered.some((index: unknown) => !Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= request.count) ||
        new Set(request.answered).size !== request.answered.length ||
        request.turnId !== undefined && (typeof request.turnId !== "string" || !identifier.test(request.turnId)) ||
        request.questionIds !== undefined && (!Array.isArray(request.questionIds) || request.questionIds.length !== request.count ||
          request.questionIds.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) || new Set(request.questionIds).size !== request.count)) return;
      checked.push({ id: request.id, name: request.name, count: request.count, answered: [...request.answered], createdAt: request.createdAt, baseline: true,
        ...(request.questionIds ? { questionIds: [...request.questionIds] } : {}),
        ...(request.turnId ? { turnId: request.turnId } : {}) });
    }
    for (const request of checked) this.requests.set(request.id, request);
  }
  consume(record: CodexInputRecord | undefined): boolean {
    if (!record) return false;
    let changed = false;
    if (record.type === "request") {
      if (this.requests.has(record.request.id)) return false;
      if (this.requests.size >= MAX_RECORDS) {
        const settled = [...this.requests.values()].find(request => request.answered.length === request.count);
        if (!settled) return false; this.requests.delete(settled.id);
      }
      this.requests.set(record.request.id, { ...record.request, answered: [] });
      return true;
    }
    if (record.type === "output") {
      const request = this.requests.get(record.id);
      if (!request) return false;
      if (record.failed) {
        if (request.answered.length === request.count) return false;
        request.answered = Array.from({ length: request.count }, (_, index) => index); return true;
      }
      // Async acceptance means a question was shown, not answered. Sync answers
      // resolve only the exact IDs supplied when that call was made.
      if (request.name !== "request_user_input" || !request.questionIds) return false;
      for (const [index, id] of request.questionIds.entries()) if (record.questionIds.includes(id) && !request.answered.includes(index)) {
        request.answered.push(index); changed = true;
      }
      request.answered.sort((a, b) => a - b); return changed;
    }
    for (const answer of record.answers) {
      const request = this.requests.get(answer.id);
      if (!request || request.name !== answer.name || answer.index >= request.count || request.answered.includes(answer.index)) continue;
      request.answered.push(answer.index); request.answered.sort((a, b) => a - b); changed = true;
    }
    return changed;
  }
  cancelTurn(turnId: string): boolean {
    let changed = false;
    for (const request of this.requests.values()) if (request.turnId === turnId && request.answered.length !== request.count) {
      request.answered = Array.from({ length: request.count }, (_, index) => index); changed = true;
    }
    return changed;
  }
  has(id: string) { return this.requests.has(id); }
  pending(turnId?: string): InputAttention[] {
    return [...this.requests.values()].filter(request => request.answered.length < request.count && (turnId === undefined || request.turnId === turnId))
      .map(request => ({ id: request.id, kind: "question", createdAt: request.createdAt, ...(request.baseline ? { baseline: true } : {}) }));
  }
  snapshot(): CodexInputSnapshot {
    return { version: 1, requests: [...this.requests.values()].map(request => ({ ...request, answered: [...request.answered],
      ...(request.questionIds ? { questionIds: [...request.questionIds] } : {}) })) };
  }
}
