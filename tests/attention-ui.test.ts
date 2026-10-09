import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { initialState, type RuntimeState } from "../packages/cockpit-state/types.js";
import { InputNeededNotice, selectedInputNeeded } from "../apps/evenhub/src/interactions/attention.js";

const state = (): RuntimeState => ({ ...initialState(), connected: true, session: { key: "selected", cwd: "/synthetic", name: "Fixture session" } });
const question = () => ({ id: "request", kind: "question" as const, title: "Question", expiresAt: 2000,
  questions: [{ id: "format", text: "Which format?", options: [{ id: "short", label: "Summary" }] }] });

test("input notices require a verified request, never a waiting tool or model menu", () => {
  const current = state(); current.main.status = "waiting"; current.tools.active.shell = { name: "bash", startedAt: 1 };
  assert.equal(selectedInputNeeded(current, 1000), undefined);
  current.interactions = [{ ...question(), kind: "menu" }];
  assert.equal(selectedInputNeeded(current, 1000), undefined);
  current.interactions = [question()]; current.main.status = "running";
  assert.deepEqual(selectedInputNeeded(current, 1000), { id: "request", key: "selected", mode: "remote" });
  assert.equal(selectedInputNeeded(current, 2000), undefined);
  current.connected = false; assert.equal(selectedInputNeeded(current, 1000), undefined);
  current.connected = true; current.session.key = undefined; assert.equal(selectedInputNeeded(current, 1000), undefined);
});

test("verified native-only attention has an explicit terminal route and expires independently", () => {
  const current = state(); current.main.status = "running";
  current.attention = [{ id: "native-question", kind: "question", expiresAt: 2000 }];
  assert.deepEqual(selectedInputNeeded(current, 1000), { id: "native-question", key: "selected", mode: "terminal" });
  assert.equal(selectedInputNeeded(current, 2000), undefined);
  current.attention[0].expiresAt = undefined;
  current.interactions = [question()];
  assert.equal(selectedInputNeeded(current, 1000)?.mode, "remote", "an answerable request takes precedence over its native fallback");
});

class Element {
  className = ""; hidden = false; type = ""; textContent = "";
  onclick?: () => void;
  children: Element[] = [];
  setAttribute() {}
  append(...children: Element[]) { this.children.push(...children); }
}
function fixture(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else delete (globalThis as any).document; });
  const opened: string[] = [], notice = new InputNeededNotice(key => opened.push(key));
  return { notice, element: notice.element as unknown as Element, opened };
}

test("the phone shortcut only navigates to its current answer panel and retires on disconnect", t => {
  const f = fixture(t), current = state(); current.interactions = [question()];
  f.notice.update(current, true, 1000);
  const [label, button] = f.element.children;
  assert.equal(f.element.hidden, false); assert.equal(button.hidden, false);
  assert.equal(label.textContent, "Needs input · Fixture session");
  button.onclick?.(); assert.deepEqual(f.opened, ["selected"]);
  current.session.key = "replacement"; f.notice.update(current, true, 1000);
  button.onclick?.(); assert.deepEqual(f.opened, ["selected", "replacement"]);
  assert.equal(f.element.children.length, 2, "unchanged structure preserves the existing controls");
  f.notice.update(current, false, 1000); button.onclick?.();
  assert.equal(f.element.hidden, true); assert.equal(f.opened.length, 2);
});

test("native-only dialogs never offer an answer button and disappear when resolved", t => {
  const f = fixture(t), current = state(); current.attention = [{ id: "native", kind: "approval" }];
  f.notice.update(current, true, 1000);
  const [label, button] = f.element.children;
  assert.match(label.textContent, /Answer in original terminal$/); assert.equal(button.hidden, true);
  button.onclick?.(); assert.deepEqual(f.opened, []);
  current.attention = []; f.notice.update(current, true, 1000);
  assert.equal(f.element.hidden, true); button.onclick?.(); assert.deepEqual(f.opened, []);
});
