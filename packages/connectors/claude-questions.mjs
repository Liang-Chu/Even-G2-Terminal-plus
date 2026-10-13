// No runtime imports: the native CLI hook can use the same adapter without tsx.
const text = (value, limit) => typeof value === "string" && !!value.trim()
  && value.length <= limit && !value.includes("\0");

/** Only question display fields are retained; arbitrary tool arguments/HTML are not. */
export function claudeQuestions(input) {
  const raw = input?.questions;
  if (!Array.isArray(raw) || !raw.length || raw.length > 4) return;
  const questions = [];
  for (const q of raw) {
    if (!text(q?.question, 2000) || q.header !== undefined && !text(q.header, 100)
      || q.multiSelect !== undefined && typeof q.multiSelect !== "boolean"
      || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
      || q.options.some(o => !text(o?.label, 500) || o.description !== undefined && !text(o.description, 2000))) return;
    questions.push({ question: q.question, ...(q.header !== undefined ? { header: q.header } : {}),
      ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
      options: q.options.map(o => ({ label: o.label, ...(o.description !== undefined ? { description: o.description } : {}) })) });
  }
  if (new Set(questions.map(q => q.question)).size !== questions.length
    || questions.some(q => new Set(q.options.map(o => o.label)).size !== q.options.length)
    || JSON.stringify(questions).length > 20_000) return;
  return questions;
}

export function claudeQuestionText(input) {
  const questions = claudeQuestions(input);
  if (!questions) return;
  return questions.map(q => [q.question, ...q.options.map((o, index) => `${index + 1}. ${o.label}${o.description ? " — " + o.description : ""}`),
    q.multiSelect ? "Choose one or enter several numbers (1,3), exact labels, or another answer."
      : "Choose an option or enter another answer."].join("\n")).join("\n\n");
}

/** Keep the existing choices and editor: one choice or a text list of several. */
export function claudeInteractionQuestions(questions) {
  if (!claudeQuestions({ questions })) return;
  return questions.map((q, index) => ({ id: "q" + index, text: q.question, allowText: true,
    ...(q.multiSelect ? { multiSelect: true } : {}),
    options: q.options.map((o, option) => ({ id: "choice:" + option, label: o.label,
      ...(o.description ? { description: o.description } : {}) })) }));
}

function questionAnswer(q, answer) {
  if (!text(answer, 8000)) throw new Error("Invalid question answer");
  const value = answer.trim();
  if (/^choice:/.test(value)) {
    const option = q.options.find((_, index) => value === "choice:" + index);
    if (!option) throw new Error("Choose one of the current options");
    return option.label;
  }
  if (!q.multiSelect) return value;
  // An exact label is always literal, even if it happens to contain a comma or number.
  if (q.options.some(o => o.label === value)) return value;
  const parts = value.split(/[,，、;；]/).map(part => part.trim());
  if (parts.every(part => /^\d+$/.test(part))) {
    const numbers = parts.map(Number);
    if (numbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > q.options.length))
      throw new Error("Use the displayed option numbers, for example 1,3");
    return [...new Set(numbers)].map(number => q.options[number - 1].label).join(", ");
  }
  if (parts.length > 1 && parts.every(part => q.options.some(o => o.label === part)))
    return [...new Set(parts)].join(", ");
  // Descriptions and mixed/unknown labels are explicit free text, never inferred selections.
  return value;
}

export function claudeQuestionAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)
    || Object.keys(answers).length !== questions.length || !claudeInteractionQuestions(questions)
    || questions.some((_, index) => !Object.hasOwn(answers, "q" + index))) throw new Error("Unsupported question answer");
  return Object.fromEntries(questions.map((q, index) => [q.question, questionAnswer(q, answers["q" + index])]));
}

/** Official PreToolUse AskUserQuestion contract. Never applies to another tool. */
export function claudeQuestionOutput(input, answers) {
  const questions = claudeQuestions(input);
  if (!questions || !answers || typeof answers !== "object" || Array.isArray(answers)
    || Object.keys(answers).length !== questions.length
    || questions.some(q => !Object.hasOwn(answers, q.question) || !text(answers[q.question], 8000))) return;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { questions, answers: Object.fromEntries(questions.map(q => [q.question, answers[q.question]])) } } };
}
