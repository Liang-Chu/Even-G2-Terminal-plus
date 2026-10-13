import type { InteractionQuestion } from "../cockpit-state/interactions.js";

export interface ClaudeQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export function claudeQuestions(input: unknown): ClaudeQuestion[] | undefined;
export function claudeQuestionText(input: unknown): string | undefined;
export function claudeInteractionQuestions(questions: ClaudeQuestion[]): InteractionQuestion[] | undefined;
export function claudeQuestionAnswers(questions: ClaudeQuestion[], answers: Record<string, string>): Record<string, string>;
export function claudeQuestionOutput(input: unknown, answers: unknown): {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow";
    updatedInput: { questions: ClaudeQuestion[]; answers: Record<string, string> };
  };
} | undefined;
