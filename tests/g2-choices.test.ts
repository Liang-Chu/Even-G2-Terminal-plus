import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { CHOICE_CONTAINER_ID } from "../apps/evenhub/src/g2/native.js";
import type { Interaction, InteractionAnswer } from "../packages/cockpit-state/interactions.js";
import { initialState } from "../packages/cockpit-state/types.js";

const choice = (id = "question"): Interaction => ({ id, kind: "question", title: "Question", expiresAt: Date.now() + 10_000,
  questions: [{ id: "format", text: "Which format?", allowText: true, options: [{ id: "short", label: "Summary" }, { id: "full", label: "Full" }] }] });
function fixture(t: any) {
  const pages: any[] = [], updates: any[] = [], answers: InteractionAnswer[] = []; let opened = 0;
  let current = { ...initialState(), connected: true, session: { key: "s", cwd: "/fixture" }, capabilities: { prompt: false, interrupt: false }, interactions: [choice()] };
  const display = new G2Display(() => {}, () => {}, undefined, {
    renderer: { pages: text => [text], render: () => [] }, respond: async (_key, answer) => { answers.push(answer); },
    input: { open: () => { opened++; display.setComposer({ text: "", hint: "Tap: record", phase: "review" }); }, toggleRecording() {} },
  });
  const bridge = { createStartUpPageContainer: async (page: any) => { pages.push(page); return 0; },
    rebuildPageContainer: async (page: any) => { pages.push(page); return true; },
    textContainerUpgrade: async (update: any) => { updates.push(update); return true; }, updateImageRawData: async () => "success",
    onEvenHubEvent: () => () => {}, setLocalStorage: async () => {}, getLocalStorage: async () => undefined };
  display.update(current, true); t.after(() => display.dispose());
  return { display, bridge, pages, updates, answers, opened: () => opened,
    update: (request: Interaction, online = true) => { current = { ...current, interactions: [request] }; display.update(current, online); } };
}

test("a mounted choice sends its hint once and only upgrades a changed submission hint", async t => {
  const f = fixture(t); await f.display.init(f.bridge as any); await delay(140);
  assert.equal(f.updates.length, 0, "the native page already contains the initial hint");
  const pageCount = f.pages.length;
  f.display.toggle(); await delay(140);
  assert.equal(f.pages.length, pageCount, "submitting retains the native choice list and focus");
  assert.deepEqual(f.updates.map(update => [update.containerID, update.content]), [[7, "Response submitted."]]);
});

test("G2 question choices use native scroll focus and do not rebuild while selecting", async t => {
  const f = fixture(t); await f.display.init(f.bridge as any); await delay(140);
  const page = f.pages.at(-1); assert.equal(validateEvenHubPageContainer(page).valid, true);
  const list = page.listObject[0]; assert.equal(list.containerID, CHOICE_CONTAINER_ID);
  assert.deepEqual(list.itemContainer.itemName, ["Summary", "Full", "Other / enter answer"]);
  assert.equal(page.imageObject, undefined); assert.equal(page.menuObject.menuItems[0].itemName, "Back");
  const count = f.pages.length;
  for (let index = 0; index < 8; index++) f.display.handleEvent({ listEvent: { containerID: CHOICE_CONTAINER_ID, eventType: 2, currentSelectItemIndex: 1 } } as any);
  await delay(140); assert.equal(f.pages.length, count, "Native focus is never reset by row rebuilds");
  f.display.handleEvent({ listEvent: { containerID: CHOICE_CONTAINER_ID, eventType: 0, currentSelectItemIndex: 1 } } as any);
  await delay(20); assert.deepEqual(f.answers[0].answers, { format: "full" });
  f.display.handleEvent({ listEvent: { containerID: CHOICE_CONTAINER_ID, eventType: 0, currentSelectItemIndex: 1 } } as any);
  assert.equal(f.answers.length, 1);
});

test("Other opens the existing editor and submits only to its captured question", async t => {
  const f = fixture(t); await f.display.init(f.bridge as any); await delay(140);
  f.display.handleEvent({ listEvent: { containerID: CHOICE_CONTAINER_ID, eventType: 0, currentSelectItemIndex: 2 } } as any);
  assert.equal(f.opened(), 1); assert.equal(f.display.hasInteractionDraft(), true);
  assert.equal(await f.display.submitInteractionDraft("Custom answer", "s"), true);
  assert.deepEqual(f.answers[0], { requestId: "question", answers: { format: "Custom answer" } });
  await assert.rejects(f.display.submitInteractionDraft("Duplicate", "s"), /changed or disconnected/);
  assert.equal(f.answers.length, 1);
});

test("a question editor rejects stale, expired and disconnected replies instead of sending a prompt", async t => {
  for (const mode of ["stale", "expired", "offline", "foreign"] as const) {
    const f = fixture(t); await f.display.init(f.bridge as any); await delay(140);
    f.display.handleEvent({ listEvent: { containerID: CHOICE_CONTAINER_ID, eventType: 0, currentSelectItemIndex: 2 } } as any);
    if (mode === "stale") f.update(choice("replacement"));
    if (mode === "expired") f.update({ ...choice(), expiresAt: Date.now() - 1 });
    if (mode === "offline") f.update(choice(), false);
    await assert.rejects(f.display.submitInteractionDraft("Do not misroute this", mode === "foreign" ? "other-session" : "s"), /changed or disconnected/);
    assert.equal(f.answers.length, 0);
  }
});

test("text-only broker questions have a selectable native input row", async t => {
  const f = fixture(t), request = choice(); request.questions[0].options = [];
  f.update(request); await f.display.init(f.bridge as any); await delay(140);
  assert.deepEqual(f.pages.at(-1).listObject[0].itemContainer.itemName, ["Other / enter answer"]);
  f.display.handleEvent({ listEvent: { containerID: CHOICE_CONTAINER_ID, currentSelectItemIndex: 0 } } as any);
  assert.equal(f.opened(), 1); assert.equal(await f.display.submitInteractionDraft("Text", "s"), true);
});

test("verified native-only questions keep readable history and direct input back to Terminal", t => {
  let body = "", opens = 0, replies = 0;
  const display = new G2Display((_, text) => { body = text; }, () => {}, undefined, {
    input: { open: () => opens++, toggleRecording() {} }, respond: async () => { replies++; },
  });
  t.after(() => display.dispose());
  const current = { ...initialState(), connected: true, session: { key: "s", cwd: "/synthetic", tunnel: "claude" as const },
    main: { status: "running" as const }, attention: [{ id: "native-question", kind: "question" as const }],
    transcript: [{ id: 1, role: "assistant" as const, text: "Which format? Summary or full?", at: 1 }] };
  display.update(current, true);
  assert.match(body, /Which format/); assert.match(body, /Answer in original terminal/);
  display.toggle(); assert.equal(opens, 0); assert.equal(replies, 0);
  display.scroll(1); display.toggle(); assert.match(body, /^Which format\?/);
  display.handleEvent({ textEvent: { eventType: 3 } } as any);
  display.update(current, false);
  assert.doesNotMatch(body, /Answer in original terminal/);
});

test("a generic background wait never becomes a native-choice warning or input blocker", t => {
  let body = "", opens = 0;
  const display = new G2Display((_, text) => { body = text; }, () => {}, undefined, {
    input: { open: () => opens++, toggleRecording() {} },
  });
  t.after(() => display.dispose());
  display.update({ ...initialState(), connected: true, session: { key: "s", cwd: "/synthetic" }, main: { status: "waiting" } }, true);
  assert.doesNotMatch(body, /Answer in original terminal/);
  display.toggle(); assert.equal(opens, 1);
});
