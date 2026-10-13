import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { InteractionPanel } from "../apps/evenhub/src/interactions/panel.js";
import { initialState } from "../packages/cockpit-state/types.js";
import { invalidMultiSelectAnswer, nativePermissionAnswer, type InteractionAnswer, type InteractionQuestion } from "../packages/cockpit-state/interactions.js";

class Element {
  textContent = ""; className = ""; value = ""; type = ""; placeholder = ""; checked = false; disabled = false; hidden = false;
  children: Element[] = [];
  oninput?: () => void; onclick?: () => void; onchange?: () => void; onsubmit?: (event: { preventDefault(): void }) => void;
  constructor(public tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector: string) {
    return this.descendants().filter(child => selector === 'input[type="radio"]'
      ? child.tag === "input" && child.type === "radio" : child.tag === selector);
  }
}
const question: InteractionQuestion = { id: "q0", text: "Which features?", multiSelect: true, allowText: true,
  options: [{ id: "choice:0", label: "Logging" }, { id: "choice:1", label: "Metrics" }, { id: "choice:2", label: "Alerts" }] };
function fixture(t: TestContext, responseError?: Error) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else delete (globalThis as any).document; });
  const answers: InteractionAnswer[] = [];
  const panel = new InteractionPanel(async (_session, answer) => { answers.push(answer); if (responseError) throw responseError; });
  const state = { ...initialState(), connected: true, session: { key: "session", cwd: "/fixture" },
    interactions: [{ id: "question", kind: "question" as const, title: "Claude needs your answer", expiresAt: Date.now() + 10_000,
      questions: [question], cancelable: true, cancelLabel: "Answer in original terminal" }] };
  panel.update(state, true);
  const element = panel.element as unknown as Element, form = element.querySelectorAll("form")[0],
    input = element.querySelectorAll("input").find(input => input.type === "text")!, send = form.querySelectorAll("button")[0];
  const submit = () => form.onsubmit?.({ preventDefault() {} });
  return { panel, state, element, form, input, send, answers, submit };
}

test("phone invalid numbered selection stays editable and sends only the corrected answer", async t => {
  const f = fixture(t);
  assert.equal(f.input.placeholder, "Numbers or labels, e.g. 1,3");
  f.input.value = "1,4"; f.input.oninput?.(); f.submit(); await nextTurn();
  assert.equal(f.answers.length, 0); assert.equal(f.send.disabled, false);
  assert.match(f.form.querySelectorAll("p")[0].textContent, /displayed option numbers/);
  f.panel.update(f.state, true);
  f.input.value = "1，3"; f.input.oninput?.(); f.submit(); await nextTurn();
  assert.deepEqual(f.answers, [{ requestId: "question", answers: { q0: "1，3" } }]);
  assert.equal(f.send.disabled, true);
});

test("phone unconfirmed replies cannot replay, and native fallback is labelled explicitly", async t => {
  const f = fixture(t, new Error("Unconfirmed transport"));
  assert.equal(f.form.querySelectorAll("button")[1].textContent, "Answer in original terminal");
  f.input.value = "Logging, Alerts"; f.input.oninput?.(); f.submit(); await nextTurn();
  assert.equal(f.answers.length, 1); assert.equal(f.send.disabled, true);
  f.panel.update(f.state, true); f.submit(); await nextTurn(); assert.equal(f.answers.length, 1);
  assert.match(f.form.querySelectorAll("p")[0].textContent, /Unconfirmed transport/);
});

test("phone refuses an expired native request without submitting a late conversation prompt", async t => {
  const f = fixture(t);
  f.input.value = "1,3"; f.input.oninput?.();
  f.state.interactions[0].expiresAt = Date.now() - 1;
  f.submit(); await nextTurn();
  assert.equal(f.answers.length, 0); assert.equal(f.send.disabled, true);
  assert.match(f.form.querySelectorAll("p")[0].textContent, /expired.*original terminal/);
});

test("phone hands a native request back without submitting its unfinished answer", async t => {
  const f = fixture(t);
  f.input.value = "Unfinished answer"; f.input.oninput?.();
  f.form.querySelectorAll("button")[1].onclick?.(); await nextTurn();
  assert.deepEqual(f.answers, [{ requestId: "question", answers: {}, cancel: true }]);
  assert.equal(f.send.disabled, true);
});

test("multi-select client validation preserves literal labels and descriptive free text", () => {
  for (const value of ["1,3", "1、3", "1；3", "Logging, Alerts", "first and third", "1, Alerts", "choice:0"])
    assert.equal(invalidMultiSelectAnswer(question, value), undefined);
  for (const value of ["0", "1,4", "999999999999999999999"])
    assert.match(invalidMultiSelectAnswer(question, value)!, /displayed option numbers/);
  assert.equal(invalidMultiSelectAnswer({ ...question, options: [{ id: "first", label: "99" }, { id: "second", label: "1,99" }] }, "1,99"), undefined);
  assert.equal(invalidMultiSelectAnswer({ ...question, multiSelect: false }, "99"), undefined);
});

test("native permission confirmations accept exact spoken decisions and reject mixed or enduring permission", () => {
  for (const value of ["allow", "Allow once.", "APPROVE!", " yes ", "允许", "允许一次。", "同意！", "是"])
    assert.equal(nativePermissionAnswer(value), "allow");
  for (const value of ["deny", "No.", "Reject!", "拒绝。", "不允许", "否"])
    assert.equal(nativePermissionAnswer(value), "deny");
  for (const value of ["always allow", "allow all", "yes, but no", "not yes", "允许所有", "允许吗", "no/yes", "maybe", ""])
    assert.equal(nativePermissionAnswer(value), undefined);
});

test("phone spoken permission validation stays editable and preserves the explicit native fallback", async t => {
  const f = fixture(t);
  f.state.interactions = [{ ...f.state.interactions[0], id: "permission", kind: "approval" as any,
    questions: [{ id: "decision", text: "Allow this operation once?", allowText: true, options: [
      { id: "allow", label: "Allow once" }, { id: "deny", label: "Deny" }] }] }];
  f.panel.update(f.state, true);
  const form = f.element.querySelectorAll("form")[0], input = form.querySelectorAll("input").find(input => input.type === "text")!,
    send = form.querySelectorAll("button")[0], submit = () => form.onsubmit?.({ preventDefault() {} });
  input.value = "always allow"; input.oninput?.(); submit(); await nextTurn();
  assert.equal(f.answers.length, 0); assert.equal(send.disabled, false);
  assert.match(form.querySelectorAll("p")[0].textContent, /allow once or deny/);
  input.value = "允许一次。"; input.oninput?.(); submit(); await nextTurn();
  assert.deepEqual(f.answers, [{ requestId: "permission", answers: { decision: "允许一次。" } }]);
});
