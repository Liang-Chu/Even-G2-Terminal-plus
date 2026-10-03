import test from "node:test";
import assert from "node:assert/strict";
import { claudeQuestions, claudeQuestionText, claudeInteractionQuestions, claudeQuestionAnswers, claudeQuestionOutput } from "../packages/connectors/claude-questions.js";
import { claudeHistory } from "../packages/connectors/catalog.js";
const input = { questions: [{ question: "Which format?", header: "Format", multiSelect: false,
  options: [{ label: "Summary", description: "Short reply", preview: "<script>private</script>" }, { label: "Full", description: "All details" }] }], private_key: "never keep this" };

test("Claude transcript questions show readable options without unrelated arguments or reasoning", () => {
  const id = "fixture-id", row = { sessionId: id, cwd: "/test", message: { role: "assistant", content: [
    { type: "thinking", thinking: "private reasoning" }, { type: "tool_use", name: "Bash", input: { command: "private command" } },
    { type: "tool_use", name: "AskUserQuestion", input },
  ] } };
  const history = claudeHistory(JSON.stringify(row), id + ".jsonl", 0)!;
  assert.equal(history.messages.length, 1); assert.equal(history.messages[0].role, "assistant");
  assert.match(history.messages[0].text, /Which format\?\n1\. Summary — Short reply\n2\. Full — All details/);
  assert.match(history.messages[0].text, /original Terminal/);
  assert.doesNotMatch(JSON.stringify(history), /private|script/);
  assert.equal(claudeHistory(JSON.stringify({ ...row, isSidechain: true }), id + ".jsonl", 0), undefined);
});

test("Claude question answers preserve the official original questions and text-keyed answers contract", () => {
  const questions = claudeQuestions(input)!;
  assert.equal(claudeInteractionQuestions(questions)![0].allowText, true);
  const answers = claudeQuestionAnswers(questions, { q0: "choice:1" });
  assert.deepEqual(answers, { "Which format?": "Full" });
  assert.deepEqual(claudeQuestionAnswers(questions, { q0: "Custom" }), { "Which format?": "Custom" });
  const result = claudeQuestionOutput(input, answers)!;
  assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(result.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(result.hookSpecificOutput.updatedInput, { questions, answers });
  assert.doesNotMatch(JSON.stringify(result), /private|<script|preview/);
  assert.equal(claudeQuestionOutput(input, { "wrong question": "Full" }), undefined);
  assert.throws(() => claudeQuestionAnswers(questions, {}));
});

test("unsupported, oversized and ambiguous questions stay native without guessed answers", () => {
  const malformed = [ {}, { questions: [] }, { questions: [input.questions[0], input.questions[0]] },
    { questions: [{ ...input.questions[0], question: "x".repeat(2001) }] },
    { questions: [{ ...input.questions[0], options: [{ label: "Same" }, { label: "Same" }] }] } ];
  for (const data of malformed) assert.equal(claudeQuestions(data), undefined);
  const multi = { questions: [{ ...input.questions[0], multiSelect: true }] };
  assert.match(claudeQuestionText(multi)!, /one or more/);
  assert.equal(claudeInteractionQuestions(claudeQuestions(multi)!), undefined);
  assert.equal(claudeQuestionOutput(multi, { "Which format?": "Summary, Full" }), undefined);
});
