import { pageText } from "./helpers/g2-page.js";
import test from "node:test";
import assert from "node:assert/strict";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { BACK_MENU_ID, SEND_MENU_ID, CONFIRM_CONTAINER_ID } from "../apps/evenhub/src/g2/native.js";
import { VoiceController } from "../apps/evenhub/src/voice/controller.js";
import { initialState } from "../packages/cockpit-state/types.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const rendered = () => new Promise(resolve => setTimeout(resolve, 150));
function fixture() {
  const layouts: any[] = [], texts: string[] = [], mic: boolean[] = [];
  let exits = 0, sent = 0, stops = 0, key = "fixture-key", finish!: (text: string) => void;
  let voice: VoiceController;
  const display = new G2Display(() => {}, () => {}, undefined, {
    renderer: { pages: text => [text], render: () => [] }, interrupt: async () => { stops++; },
    input: { open: () => voice.open(), toggleRecording: () => { void voice.toggleRecording(); }, hasDraft: () => voice.hasDraft(),
      send: () => { void voice.confirm(); }, finish: () => voice.finish(), startDeleting: () => voice.startDeleting(), stopDeleting: () => voice.stopDeleting(),
      pause: () => voice.pause(), cancel: () => voice.cancel(), audio: pcm => voice.audio(pcm) },
  });
  voice = new VoiceController({
    config: () => ({ provider: "whisper", key, language: "" }), target: () => ({ key: "current", connection: "fixture" }),
    mic: async open => { mic.push(open); return true; }, view: view => display.setComposer(view.phase === "idle" || view.background ? undefined : view),
    send: async () => { sent++; }, transcribe: () => new Promise(resolve => { finish = resolve; }),
  });
  const bridge = { createStartUpPageContainer: async (page: any) => { layouts.push(page); return 0; },
    rebuildPageContainer: async (page: any) => { layouts.push(page); return true; },
    textContainerUpgrade: async (update: any) => { if (update.containerID !== 7) texts.push(update.content); return true; }, updateImageRawData: async () => "success",
    onEvenHubEvent: () => () => {}, shutDownPageContainer: async () => { exits++; return true; },
  };
  display.update({ ...initialState(), connected: true, session: { key: "current", name: "Current", cwd: "fixture" },
    main: { status: "running" }, currentAssistantText: "Current session feedback" }, true);
  return { display, voice, mic, layouts, texts, bridge, setKey: (value: string) => { key = value; },
    finish: (text: string) => finish(text), counts: () => ({ exits, sent, stops }),
    choose: (index = 0) => display.handleEvent({ listEvent: { containerID: CONFIRM_CONTAINER_ID, currentSelectItemIndex: index } } as any),
    gesture: (eventType: number, system = false) => display.handleEvent(system
      ? { sysEvent: { eventType } } as any : { textEvent: { eventType, containerID: 1 } } as any) };
}

test("empty editor double returns directly, closes an empty recording and never sends or exits the app", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  f.gesture(0); f.gesture(0, true); await rendered(); assert.deepEqual(f.mic, []);
  assert.equal(f.layouts.at(-1).menuObject.menuItems[0].itemName, "Back");
  f.gesture(0); await rendered(); assert.match(f.texts.at(-1)!, /Listening/);
  f.gesture(3); f.gesture(3, true); await rendered();
  assert.match(pageText(f.layouts.at(-1)), /Current session feedback/);
  assert.ok(f.layouts.every(page => page.listObject?.[0]?.containerID !== CONFIRM_CONTAINER_ID));
  assert.deepEqual(f.mic, [true, false]); assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 });
  for (const draft of ["", "  \n\t", "Deleted sentence"]) {
    f.voice.open(); f.voice.edit(draft); if (draft === "Deleted sentence") f.voice.undo();
    await rendered(); f.gesture(3); await rendered();
    assert.match(pageText(f.layouts.at(-1)), /Current session feedback/);
    assert.ok(f.layouts.every(page => page.listObject?.[0]?.containerID !== CONFIRM_CONTAINER_ID));
    assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 });
  }
  f.gesture(3); await tick(); assert.equal(f.counts().stops, 0); assert.equal(f.counts().exits, 1);
});

test("cancelled mounted voice page and late transcription cannot turn Back into a terminal stop", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  await f.voice.press(); f.voice.audio(new Uint8Array(16000)); const pending = f.voice.release(); await tick(); await rendered();
  f.voice.cancel(); f.gesture(3, true); f.finish("Late cancelled transcript"); await pending; await rendered();
  assert.match(pageText(f.layouts.at(-1)), /Current session feedback/);
  assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 });
});

test("menu pauses recording and retains draft; explicit Send submits once, system exit closes mic", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  f.gesture(0); await rendered(); f.gesture(0); await rendered(); f.voice.audio(new Uint8Array(16000));
  f.gesture(4, true); await tick(); f.finish("Send this sentence"); await tick();
  f.display.handleEvent({ menuItemClickEvent: { itemID: SEND_MENU_ID } } as any);
  f.display.handleEvent({ menuItemClickEvent: { itemID: SEND_MENU_ID } } as any); await tick();
  assert.equal(f.counts().sent, 1); assert.deepEqual(f.mic, [true, false]);
  f.gesture(5, true); await rendered(); f.gesture(0); await rendered(); f.gesture(0); await rendered();
  f.gesture(6, true); await tick(); assert.deepEqual(f.mic, [true, false, true, false]);
});

test("confirmed Send & exit returns immediately and sends pending transcription once", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  await f.voice.press(); f.voice.audio(new Uint8Array(16000)); await rendered();
  f.gesture(3); f.gesture(3, true); await tick(); await rendered();
  assert.match(pageText(f.layouts.at(-1)), /Send & exit/);
  assert.deepEqual(f.layouts.at(-1).listObject[0].itemContainer.itemName, ["Send & exit", "Exit only"]);
  assert.equal(f.layouts.at(-1).imageObject, undefined, "pending audio keeps the native confirmation");
  assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 });
  // Stale editor/system clicks and Send menu events cannot bypass confirmation.
  f.gesture(0); f.gesture(0, true);
  f.display.handleEvent({ menuItemClickEvent: { itemID: SEND_MENU_ID } } as any);
  assert.equal(f.counts().sent, 0);
  f.choose(); f.choose(); await rendered();
  assert.match(pageText(f.layouts.at(-1)), /Current session feedback/);
  assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 });
  f.finish("Send this last sentence"); await tick(); await rendered();
  assert.deepEqual(f.counts(), { exits: 0, sent: 1, stops: 0 });
});

test("hold deletes one segment immediately, repeats each second, stops on release and stays in an empty editor", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  for (const text of ["First", "Second", "Third"]) {
    await f.voice.press(); f.voice.audio(new Uint8Array(16000)); const p = f.voice.release(); await tick(); f.finish(text); await p;
  }
  await rendered(); f.gesture(9); f.gesture(9, true); await rendered(); assert.equal(f.texts.at(-1), "First\n\nSecond");
  await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(f.texts.at(-1), "First");
  f.gesture(10); await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(f.texts.at(-1), "First");
  f.gesture(9); await rendered(); f.gesture(10);
  assert.equal(f.layouts.at(-1).menuObject.menuItems[0].itemName, "Back");
  assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 });
});

test("recording cursor pulses in place; setup errors without a draft return directly", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  await f.voice.press(); await rendered();
  const initial = pageText(f.layouts.at(-1)), count = f.layouts.length;
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.ok([initial, ...f.texts].some(text => text.endsWith("○")) && [initial, ...f.texts].some(text => text.endsWith("●")));
  assert.equal(f.layouts.length, count);
  f.voice.audio(new Uint8Array(16000)); f.gesture(0); await tick(); await rendered();
  assert.match(f.texts.at(-1)!, /Transcribing/); assert.doesNotMatch(f.texts.at(-1)!, /[○●]/);
  f.finish("Recorded sentence"); await tick(); await rendered(); assert.equal(f.texts.at(-1), "Recorded sentence");
  f.gesture(3); await rendered(); f.choose(); await rendered(); f.setKey(""); f.gesture(0); await rendered(); f.gesture(0); await rendered();
  assert.match(f.texts.at(-1)!, /speech API key/); f.gesture(3); await rendered();
  assert.match(pageText(f.layouts.at(-1)), /Current session feedback/);
  assert.equal(f.counts().stops, 0);
});


test("first editor menu item returns without sending and revokes late transcription", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  await f.voice.press(); f.voice.audio(new Uint8Array(16000)); await rendered();
  assert.deepEqual(f.layouts.at(-1).menuObject.menuItems.map((item: any) => item.itemName), ["Back", "Send", "Sessions"]);
  f.gesture(4, true); await tick();
  f.display.handleEvent({ menuItemClickEvent: { itemID: BACK_MENU_ID } } as any);
  f.gesture(5, true); f.finish("Discard this late sentence"); await tick(); await rendered();
  assert.match(pageText(f.layouts.at(-1)), /Current session feedback/);
  assert.deepEqual(f.mic, [true, false]); assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 });
});

test("Exit only discards the draft and aborts late transcription without sending or interrupting", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  await f.voice.press(); f.voice.audio(new Uint8Array(16000)); await rendered();
  f.gesture(3); await rendered();
  const count = f.layouts.length;
  f.display.handleEvent({ listEvent: { containerID: CONFIRM_CONTAINER_ID, eventType: 2, currentSelectItemIndex: 1 } } as any);
  await rendered(); assert.equal(f.layouts.length, count, "firmware selection never rebuilds the confirmation list");
  f.choose(1); await rendered(); f.finish("Discarded transcription"); await tick(); await rendered();
  assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 });
  assert.match(pageText(f.layouts.at(-1)), /Current session feedback/);
  assert.deepEqual(f.mic, [true, false]);
});

test("double/back dismisses the confirmation and preserves editing; a ready draft sends only after selection", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  f.voice.open(); f.voice.edit("Keep this draft"); await rendered();
  f.gesture(3); await rendered(); assert.equal(f.counts().sent, 0);
  f.gesture(3); await rendered();
  assert.equal(pageText(f.layouts.at(-1)), "Keep this draft"); assert.equal(f.counts().exits, 0);
  f.gesture(3); await rendered();
  f.display.handleEvent({ menuItemClickEvent: { itemID: BACK_MENU_ID } } as any); await rendered();
  assert.equal(pageText(f.layouts.at(-1)), "Keep this draft");
  f.gesture(3); await rendered(); f.choose(); f.choose(); await rendered();
  assert.deepEqual(f.counts(), { exits: 0, sent: 1, stops: 0 });
});

test("session change invalidates a pending confirmation and ignores its late selection", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  f.voice.open(); f.voice.edit("Do not send to another session"); await rendered();
  f.gesture(3); await rendered();
  f.display.update({ ...initialState(), connected: true, session: { key: "other", cwd: "fixture" }, currentAssistantText: "Other session" }, true);
  f.choose(); await rendered();
  assert.deepEqual(f.counts(), { exits: 0, sent: 0, stops: 0 }); assert.match(pageText(f.layouts.at(-1)), /Other session/);
});

test("transcription finishing inside confirmation neither sends nor resets the selected exit option", async t => {
  const f = fixture(); t.after(() => f.display.dispose()); await f.display.init(f.bridge as any);
  await f.voice.press(); f.voice.audio(new Uint8Array(16000)); await rendered();
  f.gesture(3); await rendered();
  f.display.handleEvent({ listEvent: { containerID: CONFIRM_CONTAINER_ID, eventType: 2, currentSelectItemIndex: 1 } } as any);
  await rendered(); const before = f.layouts.length;
  f.finish("Finished while deciding"); await tick(); await rendered();
  assert.equal(f.layouts.length, before); assert.match(pageText(f.layouts.at(-1)), /Send & exit/);
  assert.equal(f.counts().sent, 0);
  f.display.toggle(); await rendered();
  assert.match(pageText(f.layouts.at(-1)), /Current session feedback/); assert.equal(f.counts().sent, 0);
});

test("confirmation cannot send until its native page has mounted", { timeout: 5000 }, async t => {
  const f = fixture(); t.after(() => f.display.dispose());
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  f.bridge.rebuildPageContainer = async (page: any) => {
    f.layouts.push(page);
    if (page.listObject?.[0]?.containerID === CONFIRM_CONTAINER_ID) { enter(); await held; }
    return true;
  };
  await f.display.init(f.bridge as any);
  f.voice.open(); f.voice.edit("Wait for visible confirmation"); await rendered();
  f.gesture(3); await entered;
  f.choose(); f.display.toggle(); assert.equal(f.counts().sent, 0);
  release(); await rendered(); assert.equal(f.counts().sent, 0);
  f.choose(); await rendered(); assert.equal(f.counts().sent, 1);
});
