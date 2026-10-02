import type { InteractionBroker } from "./interactions.js";
import type { Interaction, InteractionQuestion } from "../cockpit-state/interactions.js";

/** Only explicit server requests become controls; assistant prose is never executable. */
export function codexInteraction(message: any, threadId: string, broker: InteractionBroker,
  respond: (result: unknown) => void): (() => void) | undefined {
  const p = message?.params;
  if (p?.threadId !== threadId || (typeof message.id !== "string" && typeof message.id !== "number")) return;
  const source = "codex:" + String(message.id);
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
    // Persistent grants/policy changes stay in the native terminal.
    const offered = Array.isArray(p.availableDecisions) ? p.availableDecisions : ["accept", "decline", "cancel"];
    const choices = [{ id: "decline", label: "Deny" }, { id: "accept", label: "Allow once" }, { id: "cancel", label: "Cancel turn" }]
      .filter(o => offered.includes(o.id));
    if (!choices.length) return;
    const detail = [p.reason, p.command, p.cwd ? "Directory: " + p.cwd : undefined,
      p.networkApprovalContext ? JSON.stringify(p.networkApprovalContext) : undefined,
      p.additionalPermissions ? JSON.stringify(p.additionalPermissions) : undefined,
      p.grantRoot ? "Write access: " + p.grantRoot : undefined].filter(x => typeof x === "string").join("\n");
    return broker.add(source, { kind: "approval", title: "Codex approval", detail,
      questions: [{ id: "decision", text: message.method.includes("fileChange") ? "Allow file changes?" : "Allow this operation?", options: choices }],
    }, async answer => { respond({ decision: answer.answers.decision }); });
  }
  if (message.method !== "item/tool/requestUserInput" || !Array.isArray(p.questions)) return;
  const questions: InteractionQuestion[] = p.questions.map((q: any) => ({
    id: q.id, text: q.question, secret: !!q.isSecret,
    allowText: !!q.isOther || !q.options?.length,
    options: (q.options || []).map((o: any, i: number) => ({ id: "choice:" + i, label: o.label, description: o.description })),
  }));
  if (questions.some(q => typeof q.id !== "string" || typeof q.text !== "string" || q.options.some(o => typeof o.label !== "string"))) return;
  const request: Omit<Interaction, "id" | "expiresAt"> & { expiresAt?: number } = { kind: "question", title: "Codex needs your input", questions };
  if (typeof p.autoResolutionMs === "number" && p.autoResolutionMs > 0) request.expiresAt = Date.now() + p.autoResolutionMs;
  return broker.add(source, request, async answer => {
    const answers = Object.fromEntries(questions.map(q => [q.id, {
      answers: [q.options.find(o => o.id === answer.answers[q.id])?.label || answer.answers[q.id]],
    }]));
    respond({ answers });
  });
}
