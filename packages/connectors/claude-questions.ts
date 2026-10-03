import type { InteractionQuestion } from "../cockpit-state/interactions.js";

export interface ClaudeQuestion {
  question: string; header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
const text = (value: unknown, limit: number): value is string => typeof value === "string" && !!value.trim()
  && value.length <= limit && !value.includes("\0");

/** Only question display fields are retained; arbitrary tool arguments/HTML are not. */
export function claudeQuestions(input: unknown): ClaudeQuestion[] | undefined {
  const raw = (input as any)?.questions;
  if (!Array.isArray(raw) || !raw.length || raw.length > 4) return;
  const questions: ClaudeQuestion[] = [];
  for (const q of raw) {
    if (!text(q?.question, 2000) || q.header !== undefined && !text(q.header, 100)
      || q.multiSelect !== undefined && typeof q.multiSelect !== "boolean"
      || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
      || q.options.some((o: any) => !text(o?.label, 500) || o.description !== undefined && !text(o.description, 2000))) return;
    questions.push({ question: q.question, ...(q.header !== undefined ? { header: q.header } : {}),
      ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
      options: q.options.map((o: any) => ({ label: o.label, ...(o.description !== undefined ? { description: o.description } : {}) })) });
  }
  if (new Set(questions.map(q => q.question)).size !== questions.length
    || questions.some(q => new Set(q.options.map(o => o.label)).size !== q.options.length)
    || JSON.stringify(questions).length > 20_000) return;
  return questions;
}

export function claudeQuestionText(input: unknown): string | undefined {
  const questions = claudeQuestions(input);
  if (!questions) return;
  return questions.map(q => [q.question, ...q.options.map((o, index) => `${index + 1}. ${o.label}${o.description ? " — " + o.description : ""}`),
    q.multiSelect ? "Choose one or more in the original Terminal." : "Or enter another answer in the original Terminal."].join("\n")).join("\n\n");
}

/** Current broker answers are single selections or text. Multi-select stays native. */
export function claudeInteractionQuestions(questions: ClaudeQuestion[]): InteractionQuestion[] | undefined {
  if (questions.some(q => q.multiSelect)) return;
  return questions.map((q, index) => ({ id: "q" + index, text: q.question, allowText: true,
    options: q.options.map((o, option) => ({ id: "choice:" + option, label: o.label,
      ...(o.description ? { description: o.description } : {}) })) }));
}

export function claudeQuestionAnswers(questions: ClaudeQuestion[], answers: Record<string, string>) {
  if (Object.keys(answers).length !== questions.length || !claudeInteractionQuestions(questions)) throw new Error("Unsupported question answer");
  return Object.fromEntries(questions.map((q, index) => {
    const answer = answers["q" + index];
    if (!text(answer, 8000)) throw new Error("Invalid question answer");
    const option = q.options.find((_, option) => answer === "choice:" + option);
    return [q.question, option?.label || answer.trim()];
  }));
}

/** Official PreToolUse AskUserQuestion contract. Never applies to another tool. */
export function claudeQuestionOutput(input: unknown, answers: unknown) {
  const questions = claudeQuestions(input);
  if (!questions || !claudeInteractionQuestions(questions) || !answers || typeof answers !== "object" || Array.isArray(answers)
    || Object.keys(answers).length !== questions.length
    || questions.some(q => !Object.hasOwn(answers, q.question) || !text((answers as any)[q.question], 8000))) return;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { questions, answers: Object.fromEntries(questions.map(q => [q.question, (answers as any)[q.question]])) } } };
}
