export interface InteractionQuestion {
  id: string;
  text: string;
  options: { id: string; label: string; description?: string }[];
  allowText?: boolean;
  /** Multiple Claude selections use the existing text editor, with option numbers or labels. */
  multiSelect?: boolean;
  secret?: boolean;
}
export interface Interaction {
  id: string;
  createdAt?: number;
  title: string;
  detail?: string;
  kind: "approval" | "question" | "menu";
  questions: InteractionQuestion[];
  expiresAt: number;
  cancelable?: boolean;
  /** A cancel can return control to a native terminal instead of cancelling its task. */
  cancelLabel?: string;
}
export interface InteractionAnswer {
  requestId: string;
  answers: Record<string, string>;
  cancel?: boolean;
}

/** Reject invalid numbered selections before claiming a once-only remote reply.
 * Descriptions stay free text, and an exact numeric/comma option label is literal. */
export function invalidMultiSelectAnswer(question: InteractionQuestion, answer: string): string | undefined {
  if (!question.multiSelect) return;
  const value = answer.trim();
  if (question.options.some(option => option.label === value || option.id === value)) return;
  const parts = value.split(/[,，、;；]/).map(part => part.trim());
  if (parts.every(part => /^\d+$/.test(part)) && parts.map(Number).some(number =>
    !Number.isSafeInteger(number) || number < 1 || number > question.options.length))
    return "Use the displayed option numbers, for example 1,3";
}

/** Exact spoken confirmations only; never infer permission from a description. */
export function nativePermissionAnswer(answer: string): "allow" | "deny" | undefined {
  const value = answer.trim().replace(/[.!?。！？,，;；:：\s]+$/u, "").toLowerCase();
  if (["allow", "allow once", "approve", "yes", "允许", "允许一次", "同意", "是"].includes(value)) return "allow";
  if (["deny", "no", "reject", "拒绝", "不允许", "否"].includes(value)) return "deny";
}

export function invalidInteractionAnswer(request: Pick<Interaction, "kind">, question: InteractionQuestion, answer: string): string | undefined {
  const invalid = invalidMultiSelectAnswer(question, answer);
  if (invalid) return invalid;
  if (request.kind === "approval" && question.id === "decision" && question.allowText
    && question.options.some(option => option.id === "allow") && question.options.some(option => option.id === "deny")
    && nativePermissionAnswer(answer) === undefined) return "Answer allow once or deny.";
}

/** G2 never approves a command whose full details do not fit on its screen. */
export function glassesInteraction(request: Interaction) {
  const q = request.questions[0];
  return request.questions.length === 1 && !!q && (q.options.length > 0 || q.allowText === true) && q.options.length <= 8
    && q.text.length <= 100 && (request.detail?.length || 0) <= 100
    && q.options.every(o => o.label.length <= 60 && (o.description?.length || 0) <= 80);
}
