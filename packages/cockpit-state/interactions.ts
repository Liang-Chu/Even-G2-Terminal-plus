export interface InteractionQuestion {
  id: string;
  text: string;
  options: { id: string; label: string; description?: string }[];
  allowText?: boolean;
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
}
export interface InteractionAnswer {
  requestId: string;
  answers: Record<string, string>;
  cancel?: boolean;
}

/** G2 never approves a command whose full details do not fit on its screen. */
export function glassesInteraction(request: Interaction) {
  const q = request.questions[0];
  return request.questions.length === 1 && !!q && (q.options.length > 0 || q.allowText === true) && q.options.length <= 8
    && q.text.length <= 100 && (request.detail?.length || 0) <= 100
    && q.options.every(o => o.label.length <= 60 && (o.description?.length || 0) <= 80);
}
