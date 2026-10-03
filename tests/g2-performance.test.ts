import { pageText } from "./helpers/g2-page.js";
import test from "node:test";
import assert from "node:assert/strict";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { CanvasG2Renderer, type G2Frame } from "../apps/evenhub/src/g2/renderer.js";
import { initialState } from "../packages/cockpit-state/types.js";
import { NEXT_PART_MENU_ID } from "../apps/evenhub/src/g2/native.js";
import { messageLabel, messageParts } from "../apps/evenhub/src/g2/messages.js";
import type { TestContext } from "node:test";

const wait = (ms = 140) => new Promise(resolve => setTimeout(resolve, ms));
const longText = Array.from({ length: 180 }, (_, i) => `History ${String(i).padStart(3, "0")}: a previous paragraph.`).join("\n");
const runtime = () => ({ ...initialState(), connected: true, session: { key: "pi", cwd: "/project", name: "Long name ".repeat(100), model: "deepseek/deepseek-v4-pro" },
  currentAssistantText: longText });

test("native scrolling produces zero BLE writes and explicit menu parts retain messages over 2,000 characters", async t => {
  const documents: string[] = []; let wraps = 0, layouts = 0;
  const bridge = {
    createStartUpPageContainer: async (page: any) => { layouts++; documents.push(pageText(page)); return 0; },
    rebuildPageContainer: async (page: any) => { layouts++; documents.push(pageText(page)); return true; },
    textContainerUpgrade: async (update: any) => { documents.push(update.content); return true; },
    onEvenHubEvent: () => () => {}, updateImageRawData: async () => "success",
  };
  const display = new G2Display(() => {}, () => {}, undefined, {
    renderer: { pages: text => { wraps++; return [text]; }, render: () => [] },
  });
  t.after(() => display.dispose()); display.update(runtime(), true); await display.init(bridge as any); await wait();
  assert.match(documents.at(-1)!, /History 000/);
  display.scroll(1); display.toggle(); await wait();
  assert.match(documents.at(-1)!, /History 000/);
  const originalWraps = wraps, originalWrites = documents.length, originalLayouts = layouts;
  for (let i = 0; i < 190; i++) display.handleEvent({ textEvent: { eventType: 1, containerID: 1 } } as any);
  await wait();
  assert.match(documents.at(-1)!, /History 000/);
  assert.equal(documents.length, originalWrites); assert.equal(layouts, originalLayouts);
  assert.equal(wraps, originalWraps, "firmware scrolls without asking the app to wrap or resend text");
  display.update({ ...runtime(), hosts: [{ id: "other", name: "nuc", nameSource: "tailscale", online: false }] }, true);
  await wait(); assert.match(documents.at(-1)!, /History 000/); assert.equal(wraps, originalWraps);
  for (let i = 1; i < messageParts(longText).length; i++) {
    display.handleEvent({ menuItemClickEvent: { itemID: NEXT_PART_MENU_ID } } as any); await wait();
  }
  assert.match(documents.at(-1)!, /History 179/);
  assert.ok(documents.every(text => text.length <= 1850));
});

test("static headers and body-only updates reuse the actual canvas PNG encodings", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  let encodings = 0;
  const painted: { text: string; x: number; y: number; font: string }[] = [], rectangles: number[][] = [], encodedText: string[][] = [];
  let frameText: string[] = [];
  const context = { font: "", fillStyle: "", textBaseline: "", fillRect(...box: number[]) { rectangles.push(box); if (box.join() === "0,0,576,288") frameText = []; }, fillText(text: string, x: number, y: number) { painted.push({ text, x, y, font: context.font }); frameText.push(text); }, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, drawImage() {}, measureText: (text: string) => ({ width: Array.from(text).length * 9 }) };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ width: 0, height: 0,
    getContext: () => context, toDataURL: () => { encodedText.push([...frameText]); return `data:image/png;base64,${Buffer.from(String(++encodings)).toString("base64")}`; } }) } });
  try {
    const renderer = new CanvasG2Renderer();
    const frame: G2Frame = { prefix: "liam · agents: 1 |", title: "Pi · deepseek-v4-pro | " + "Long title ".repeat(50), body: "Reply", status: "running", footer: "Tap: edit" };
    const initial = renderer.render(frame, 0);
    assert.equal(encodings, 4);
    assert.equal(painted.find(item => item.y === 269)!.font, painted.find(item => item.y === 7)!.font, "both bars use the same small font");
    assert.deepEqual(rectangles.filter(box => box[1] >= 262), [[8, 262, 560, 1]], "footer has only a top separator, no box or side stroke");
    assert.ok(encodedText.every(texts => !texts.includes("Reply")), "native body content must not be sent in raster images");
    const title = painted.find(item => item.y === 7 && item.x > 8)!;
    assert.ok(title.text.endsWith("..."), "reserve visible space for the truncation marker");
    assert.ok(title.x + context.measureText(title.text).width <= 568, "ellipsis is inside the display boundary");
    assert.ok(title.text.length < frame.title.length, "offscreen title text never reaches fillText");
    assert.deepEqual(renderer.render(frame, 60_000), initial, "long titles do not animate");
    assert.deepEqual(renderer.render({ ...frame, body: "Earlier paragraph" }, 90_000), initial);
    assert.equal(encodings, 4, "history movement never encodes decorative images");
    renderer.render({ ...frame, prefix: "liam · agents: 0 |" }, 90_000);
    assert.equal(encodings, 6, "header changes leave both bottom tiles cached");
    const count = encodings;
    renderer.render({ ...frame, prefix: "liam · agents: 0 |", footer: "Different hint" }, 90_000);
    assert.equal(encodings, count + 2, "footer changes leave both top tiles cached");
    const list = { labels: ["New prompt", messageLabel({ id: "a", role: "assistant", text: "Agent answer" }),
      messageLabel({ id: "u", role: "user", text: "User question" })], selected: 0 };
    const before = encodings;
    renderer.render({ ...frame, prefix: "liam · agents: 0 |", footer: "Different hint", list }, 90000);
    renderer.render({ ...frame, prefix: "liam · agents: 0 |", footer: "Different hint", list: { ...list, selected: 2 } }, 90000);
    assert.equal(encodings, before, "native rows and native selection encode no pixels");
    assert.deepEqual(frameText.filter(text => /Agent answer|User question/.test(text)), ["  ← Agent answer", "→ User question"],
      "the mobile canvas paints native labels verbatim, including the agent's leading spaces");
    assert.ok(encodedText.every(texts=>!texts.some(text=>text.includes("Agent answer")||text.includes("User question"))));

  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document");
  }
});

function pacedFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  const documents: string[] = [], images: number[] = [], viewed: (string | undefined)[] = [], updates: any[] = [];
  let renders = 0, previews = 0, wraps = 0, layouts = 0;
  const bridge = {
    createStartUpPageContainer: async (page: any) => { layouts++; documents.push(pageText(page)); return 0; },
    rebuildPageContainer: async (page: any) => { layouts++; documents.push(pageText(page)); return true; },
    textContainerUpgrade: async (update: any) => { if (update.containerID !== 7) documents.push(update.content); updates.push(update); return true; },
    onEvenHubEvent: () => () => {},
    updateImageRawData: async (tile: any) => { images.push(tile.containerID); return "success"; },
  };
  const display = new G2Display(() => { previews++; }, () => {}, undefined, {
    viewed: key => viewed.push(key),
    renderer: { pages: text => { wraps++; return [text]; }, render: frame => {
      renders++;
      return [frame.prefix, frame.title, frame.footer, frame.footer].map((value, index) => ({
        id: index + 2, name: `tile-${index}`, png: `data:image/png;base64,${Buffer.from(value).toString("base64")}`,
      }));
    } },
  });
  t.after(() => display.dispose());
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
  return { bridge, display, advance, documents, images, viewed, updates, counts: () => ({ renders, previews, wraps, layouts }) };
}

test("native list streaming never rebuilds rows or focus; returning to the list loads the newest snapshot once", async t => {
  const f=pacedFixture(t), state={...runtime(),main:{status:"running" as const}};
  f.display.update(state,true); await f.display.init(f.bridge as any); await f.advance(60);
  const before=f.counts(); f.documents.length=0; f.images.length=0;
  for(let i=0;i<100;i++){f.display.update({...state,currentAssistantText:"Stream "+i+"\n"+longText},true);await f.advance(10);}
  await f.advance(250);
  assert.equal(f.counts().layouts,before.layouts);assert.equal(f.documents.length,0);
  assert.ok(f.images.length<=2,"only the new-content footer changes, once");
  f.display.back();await f.advance(60);
  assert.equal(f.counts().layouts,before.layouts+1);assert.match(f.documents.at(-1)!,/Stream 99/);
});

test("unchanged clock/host snapshots and menu dismissal do not redraw or retransmit", async t => {
  const f = pacedFixture(t), state = runtime();
  f.display.update(state, true); await f.display.init(f.bridge as any); await f.advance(60);
  const before = f.counts(), imageCount = f.images.length, documentCount = f.documents.length;
  for (let i = 0; i < 10; i++) {
    f.display.update({ ...state, hosts: [{ id: "other", name: "nuc", nameSource: "tailscale", online: !!(i % 2) }] }, true);
    await f.advance(500); await f.advance(60);
  }
  f.display.handleEvent({ sysEvent: { eventType: 4 } } as any);
  f.display.handleEvent({ sysEvent: { eventType: 5 } } as any); await f.advance(60);
  assert.deepEqual(f.counts(), before); assert.equal(f.images.length, imageCount); assert.equal(f.documents.length, documentCount);
});

test("network recovery changes only affected tiles; explicit BLE resync resends cached images", async t => {
  const f = pacedFixture(t), state = runtime();
  f.display.update(state, true); await f.display.init(f.bridge as any); await f.advance(60);
  f.images.length = 0;
  f.display.update(state, false); await f.advance(60);
  assert.deepEqual(f.images, [2, 4, 5], "connection updates change count/status tiles, retaining the title");
  f.images.length = 0;
  f.display.update(state, true); await f.advance(60);
  assert.deepEqual(f.images, [2, 4, 5], "network recovery retains the title tile");
  const before = f.counts(); f.images.length = 0;
  f.display.resync(); await f.advance(60);
  assert.deepEqual(f.images, [2, 3, 4, 5]); assert.deepEqual(f.counts(), before, "BLE recovery reuses encoded PNGs");
});

test("native list session switch reports presence only after the new list acknowledgement", async t => {
  const f=pacedFixture(t),state=runtime();
  f.display.update(state,true);await f.display.init(f.bridge as any);await f.advance(60);
  let release!:()=>void;const original=f.bridge.rebuildPageContainer;
  f.bridge.rebuildPageContainer=async page=>{await new Promise<void>(resolve=>{release=resolve;});return original(page);};
  t.after(()=>release?.());
  f.display.update({...state,session:{...state.session,key:"other"},currentAssistantText:longText.replaceAll("History","Archive")},true);
  assert.equal(f.viewed.at(-1),undefined);await f.advance(60);assert.equal(f.viewed.at(-1),undefined);
  release();await f.advance(0);
  assert.equal(f.viewed.at(-1),"other");assert.match(f.documents.at(-1)!,/Archive/);
});

