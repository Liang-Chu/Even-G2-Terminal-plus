import { pageText } from "./helpers/g2-page.js";
import test from "node:test";
import assert from "node:assert/strict";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { GESTURE_CONTAINER_ID, nativeBody, nativeLabel, nativeLayout } from "../apps/evenhub/src/g2/native.js";
import { initialState, type RuntimeState } from "../packages/cockpit-state/types.js";
import type { SessionSummary } from "../apps/evenhub/src/sessions/panel.js";

const wait = (ms = 130) => new Promise(resolve => setTimeout(resolve, ms));
const runtime = (text = "First line\n".repeat(30), key = "S0"): RuntimeState => ({ ...initialState(),
  connected: true, session: { key, name: key, cwd: "C:/fixture" }, currentAssistantText: text });
const sessions = (count = 3): SessionSummary[] => Array.from({ length: count }, (_, i) => ({
  key: `S${i}`, id: `S${i}`, name: `Session ${i}`, cwd: "C:/fixture", monitored: true,
  runtimeStatus: i === 0 ? "running" : "idle", messageCount: 4, updatedAt: count - i,
}));
const renderer = { pages: (text: string) => [text], render: () => [] };

test("terminal and editor capture gestures on a blank layer, so firmware cannot bounce the visible body", () => {
  for (const mode of ["terminal", "composer"]) {
    const layout = nativeLayout({ layoutKey: mode + ":session", body: "Visible reply\n".repeat(7) });
    assert.ok("textObject" in layout && "imageObject" in layout);
    const texts = layout.textObject!, images = layout.imageObject!;
    assert.equal(layout.containerTotalNum, texts.length + images.length);
    const body = texts.find(text => text.containerName === "pilot-body")!;
    const capture = texts.filter(text => text.isEventCapture === 1);
    assert.equal(body.isEventCapture, 0); assert.equal(capture.length, 1);
    assert.equal(capture[0].containerID, GESTURE_CONTAINER_ID); assert.equal(capture[0].content, " ");
    assert.ok(capture[0].zOrderIndex! < body.zOrderIndex!);
    assert.equal(new Set([...texts, ...images].map(item => item.zOrderIndex)).size, layout.containerTotalNum);
  }
  const picker = nativeLayout({ layoutKey: "picker", picker: true, body: "", entries: [{ key: "a", label: "A" }] });
  assert.ok("listObject" in picker);
  assert.equal(picker.listObject![0].isEventCapture, 1, "native session selection keeps its original capture layer");
});
function bridgeRecorder() {
  const layouts: any[] = [], texts: string[] = [];
  const bridge = {
    createStartUpPageContainer: async (page: any) => { layouts.push(page); return 0; },
    rebuildPageContainer: async (page: any) => { layouts.push(page); return true; },
    textContainerUpgrade: async (update: any) => { if (update.containerID !== 7) texts.push(update.content); return true; },
    updateImageRawData: async () => "success",
    onEvenHubEvent: () => () => {}, getLocalStorage: async () => "S0", setLocalStorage: async () => true,
  };
  return { bridge, layouts, texts };
}

test("native conversation taps select every row without any JavaScript swipe event", async t => {
 const {bridge,layouts,texts}=bridgeRecorder();let opens=0;
 const display=new G2Display(()=>{},()=>{},undefined,{renderer,input:{open:()=>{opens++;},toggleRecording(){}}});
 t.after(()=>display.dispose());
 const transcript=Array.from({length:10},(_,i)=>({id:i,at:i,role:"assistant" as const,text:"Message "+i}));
 display.update({...runtime(""),transcript},true);await display.init(bridge as any);await wait();
 assert.equal(layouts.at(-1).listObject[0].itemContainer.itemCount,11);
 for(let row=1;row<=10;row++) {
   const before=layouts.length,writes=texts.length;
   // The firmware can scroll/highlight without emitting selection callbacks.
   display.handleEvent({textEvent:{eventType:2,containerID:8}} as any);await wait();
   assert.equal(layouts.length,before);assert.equal(texts.length,writes);
   display.handleEvent({listEvent:{containerID:8,currentSelectItemIndex:row}} as any);await wait();
   assert.equal(pageText(layouts.at(-1)),"Message "+(10-row));
   display.handleEvent({sysEvent:{eventType:3}} as any);await wait();
   assert.ok(layouts.at(-1).listObject); assert.equal(opens,0);
 }
 display.handleEvent({listEvent:{containerID:8}} as any);assert.equal(opens,1,"omitted protobuf index is input row zero");
});

test("gesture diagnostics retain event metadata but never conversation or audio", async t => {
 const {bridge}=bridgeRecorder(),traces:any[]=[];
 const display=new G2Display(()=>{},()=>{},undefined,{renderer,inputTrace:value=>traces.push(value)});
 t.after(()=>display.dispose());display.update(runtime("Private response"),true);await display.init(bridge as any);await wait();
 display.handleEvent({textEvent:{eventType:2,containerID:8}} as any);
 assert.deepEqual([traces.at(-1).before,traces.at(-1).after],[0,0],"native scroll never moves an app-drawn cursor");
 display.handleEvent({listEvent:{containerID:8,currentSelectItemIndex:1}} as any);
 assert.equal(traces.at(-1).after,1);
 const count=traces.length;
 display.handleEvent({audioEvent:{audioPcm:new Uint8Array([11,22,33])}} as any);
 assert.equal(traces.length,count);assert.doesNotMatch(JSON.stringify(traces),/Private|response|prompt|audioPcm/);
});

test("native list consumes firmware indices once and never rebuilds or resets focus while scrolling", async t => {
  const { bridge, layouts, texts } = bridgeRecorder(); let opened = "";
  const display = new G2Display(() => {}, () => {}, {
    list: async () => sessions(), open: async key => { opened = key; return runtime("Selected", key); },
  }, { renderer });
  t.after(() => display.dispose()); display.update(runtime(), true); await display.init(bridge as any); await wait();
  await display.openSessions(); await wait();
  assert.equal(layouts.at(-1).listObject[0].itemContainer.itemCount, 3);
  const before = layouts.length, textCount = texts.length;
  // Duplicate delivery of the same native selection must not advance twice.
  for (let i = 0; i < 5; i++) display.handleEvent({ listEvent: { eventType: 2, currentSelectItemIndex: 1 } } as any);
  display.update(runtime("Background update"), true); await wait(650);
  assert.equal(layouts.length, before); assert.equal(texts.length, textCount);
  display.handleEvent({ sysEvent: { eventSource: 1 } } as any); await wait();
  assert.equal(opened, "S1"); assert.ok(layouts.at(-1).textObject);
  await display.openSessions(); await wait(); opened = "";
  display.update({ ...runtime(), monitoring: { watched: 2, running: 1, since: 0,
    sessions: sessions().filter(item => item.key !== "S1").map(item => ({ key: item.key, name: item.name || item.key,
      cwd: item.cwd, monitored: true, status: item.runtimeStatus, current: item.key === "S0" })) } }, true);
  // A queued click still refers to the old native row; never open its replacement.
  display.handleEvent({ listEvent: { currentSelectItemIndex: 1 } } as any); await wait();
  assert.equal(opened, "");
});

test("incoming messages do not rebuild native rows; returning and session switch show the latest data", async t => {
 const {bridge,layouts,texts}=bridgeRecorder();const display=new G2Display(()=>{},()=>{},undefined,{renderer});
 t.after(()=>display.dispose());display.update(runtime(),true);await display.init(bridge as any);await wait();
 const before=layouts.length,writes=texts.length;
 display.update(runtime("New streamed result"),true);await wait(650);
 assert.equal(layouts.length,before);assert.equal(texts.length,writes);
 display.back();await wait();
 assert.equal(layouts.length,before+1);assert.match(pageText(layouts.at(-1)),/New streamed result/);
 display.update(runtime("Next streamed reply","S2"),true);await wait();
 assert.equal(layouts.length,before+2);assert.match(pageText(layouts.at(-1)),/Next streamed reply/);
});

test("phone pushes coalesced desktop messages to the open G2 overview without reopening", async t => {
  const { bridge, layouts } = bridgeRecorder();
  const display = new G2Display(() => {}, () => {}, undefined, { renderer });
  t.after(() => display.dispose());
  display.update(runtime("Original reply"), true); await display.init(bridge as any); await wait();
  const before = layouts.length;
  for (let i = 0; i < 30; i++) display.update(runtime("Desktop stream " + i), true);
  await wait(650); assert.equal(layouts.length, before, "token chunks do not rebuild the list separately");
  await wait(1700);
  assert.equal(layouts.length, before + 1); assert.match(pageText(layouts.at(-1)), /Desktop stream 29/);
  // A longer full reply can have an unchanged one-line label; opening must still
  // use the new text, even when no row rebuild is needed.
  const prefix = "A long reply that already fills the native preview row with several complete words. ";
  display.update(runtime(prefix + "old ending"), true); await wait(2200);
  const latest = layouts.length;
  display.update(runtime(prefix + "new ending"), true); await wait(2200);
  assert.equal(layouts.length, latest, "identical native labels consume no extra rebuild");
  display.handleEvent({ listEvent: { containerID: 8, currentSelectItemIndex: 1 } } as any); await wait();
  assert.match(pageText(layouts.at(-1)), /new ending/);
});

test("new replies wait while browsing native rows or long text and appear on return", async t => {
  const { bridge, layouts } = bridgeRecorder();
  const display = new G2Display(() => {}, () => {}, undefined, { renderer });
  t.after(() => display.dispose());
  display.update(runtime("Message being selected"), true); await display.init(bridge as any); await wait();
  const before = layouts.length;
  // Firmware may emit a scroll event without its index. Do not assume row zero.
  display.handleEvent({ textEvent: { eventType: 2, containerID: 8 } } as any);
  display.update(runtime("New reply during browsing"), true); await wait(2400);
  assert.equal(layouts.length, before);
  display.handleEvent({ listEvent: { containerID: 8, currentSelectItemIndex: 1 } } as any); await wait();
  assert.match(pageText(layouts.at(-1)), /Message being selected/);
  const reading = layouts.length;
  display.update(runtime("Latest reply while reading"), true); await wait(2400);
  assert.equal(layouts.length, reading);
  display.back(); await wait();
  assert.match(pageText(layouts.at(-1)), /Latest reply while reading/);
});

test("basic G2 view updates its clock and status without rebuilding the conversation list", async t => {
  const { bridge, layouts } = bridgeRecorder(); const hints: string[] = [];
  bridge.createStartUpPageContainer = async (page: any) => {
    if (page.imageObject?.length || page.containerTotalNum !== 3) return 1;
    layouts.push(page); return 0;
  };
  bridge.textContainerUpgrade = async (update: any) => { if (update.containerID === 7) hints.push(update.content); return true; };
  const display = new G2Display(() => {}, () => {}, undefined, { renderer });
  t.after(() => display.dispose());
  const state = { ...runtime("Result"), main: { status: "running" as const, startedAt: Date.now() - 10000 } };
  display.update(state, true); await display.init(bridge as any); await wait();
  const before = layouts.length;
  display.update({ ...state, main: { ...state.main, startedAt: state.main.startedAt - 5000 } }, true); await wait(350);
  assert.equal(layouts.length, before); assert.match(hints.at(-1)!, /running 00:15/);
});

test("more than twenty watched sessions remain selectable with native list navigation rows", async t => {
  const { bridge, layouts } = bridgeRecorder(); let opened = "";
  const display = new G2Display(() => {}, () => {}, {
    list: async () => sessions(40), open: async key => { opened = key; return runtime("Selected", key); },
  }, { renderer });
  t.after(() => display.dispose()); display.update(runtime(), true); await display.init(bridge as any); await wait();
  await display.openSessions(); await wait();
  assert.equal(layouts.at(-1).listObject[0].itemContainer.itemCount, 19);
  display.handleEvent({ listEvent: { eventType: 2, currentSelectItemIndex: 18 } } as any);
  display.handleEvent({ sysEvent: { eventSource: 1 } } as any); await wait();
  assert.equal(layouts.at(-1).listObject[0].itemContainer.itemCount, 20);
  display.handleEvent({ listEvent: { eventType: 0, currentSelectItemIndex: 5 } } as any); await wait();
  assert.equal(opened, "S23");
});

test("native text and list labels honor SDK limits without broken surrogate pairs", () => {
  const label = nativeLabel("中文😀".repeat(40));
  assert.ok(new TextEncoder().encode(label).length <= 63); assert.ok(label.endsWith("..."));
  const body = nativeBody("😀".repeat(1500));
  assert.ok(body.length <= 2000); assert.equal(new TextDecoder().decode(new TextEncoder().encode(body)), body); assert.match(body, /Earlier text in Terminal/);
});

test("Sessions uses the streamed watch snapshot and sends no images or clock refreshes while choosing", async t => {
  const { bridge, layouts } = bridgeRecorder();
  let listCalls = 0, images = 0, renders = 0;
  const encodings: boolean[] = [];
  bridge.updateImageRawData = async () => { images++; return "success"; };
  const display = new G2Display(() => {}, () => {}, {
    list: async () => { listCalls++; return sessions(); }, open: async key => runtime("Selected", key),
  }, { renderer: { pages: text => [text], render: (_, __, encode = true) => {
    renders++; encodings.push(encode);
    // Even an injected renderer returning tiles must not put picker images on BLE.
    return [{ id: 2, name: "tile", png: "data:image/png;base64,AA==" }];
  } } });
  t.after(() => display.dispose());
  const state = { ...runtime(), monitoring: { watched: 3, running: 1, since: 0,
    sessions: sessions().map(item => ({ key: item.key, name: item.name!, cwd: item.cwd,
      monitored: true, status: item.runtimeStatus, current: item.key === "S0", updatedAt: item.updatedAt })) } };
  display.update(state, true); await display.init(bridge as any); await wait();
  const callsBefore = listCalls;
  await display.openSessions(); await wait();
  assert.equal(listCalls, callsBefore, "opening Sessions must not request all saved history");
  const page = layouts.at(-1);
  assert.equal(page.containerTotalNum, 3); assert.equal(page.imageObject?.length || 0, 0);
  assert.equal(page.listObject[0].itemContainer.itemCount, 3);
  assert.equal(encodings.at(-1), false, "picker previews must skip PNG encoding");
  const before = { images, renders, layouts: layouts.length };
  await wait(1100);
  display.update({ ...state, subagents: { active: 3 }, currentAssistantText: "Background stream" }, true); await wait();
  assert.equal(renders, before.renders, "clock and agent updates must not redraw the picker");
  display.handleEvent({ listEvent: { eventType: 2, currentSelectItemIndex: 1 } } as any); await wait();
  assert.equal(images, before.images); assert.equal(layouts.length, before.layouts);
});

test("a pending session open updates only its heading and keeps the native list mounted", async t => {
  const { bridge, layouts, texts } = bridgeRecorder();
  let finish!: () => void, calls = 0;
  const display = new G2Display(() => {}, () => {}, {
    list: async () => sessions(), open: async key => {
      calls++; await new Promise<void>(resolve => { finish = resolve; }); return runtime("Selected", key);
    },
  }, { renderer });
  t.after(() => display.dispose()); display.update(runtime(), true); await display.init(bridge as any); await wait();
  await display.openSessions(); await wait(); const before = layouts.length;
  display.handleEvent({ listEvent: { currentSelectItemIndex: 1 } } as any); await wait();
  assert.equal(layouts.length, before, "no intermediate loading-page rebuild");
  assert.equal(texts.at(-1), "Opening session…");
  display.handleEvent({ listEvent: { currentSelectItemIndex: 2 } } as any);
  assert.equal(calls, 1, "duplicate taps must not start another session open");
  finish(); await wait();
  assert.equal(layouts.length, before + 1); assert.match(pageText(layouts.at(-1)), /Selected/);
});

test("entering Sessions stops a slow image batch after its already in-flight tile", async t => {
  const { bridge, layouts } = bridgeRecorder(); let images = 0, release!: () => void;
  bridge.updateImageRawData = async () => { images++; await new Promise<void>(resolve => { release = resolve; }); return "success"; };
  const display = new G2Display(() => {}, () => {}, { list: async () => sessions(), open: async key => runtime("Selected", key) }, {
    renderer: { pages: text => [text], render: () => Array.from({ length: 4 }, (_, index) => ({
      id: index + 2, name: `tile-${index}`, png: "data:image/png;base64,AA==",
    })) },
  });
  t.after(() => { release?.(); display.dispose(); });
  display.update(runtime(), true); await display.init(bridge as any); await wait();
  assert.equal(images, 1);
  await display.openSessions(); release(); await wait();
  assert.ok(layouts.at(-1).listObject); assert.equal(images, 1);
  await wait(650); assert.equal(images, 1, "no stale decorations after the list mounts");
});

test("opening a running session shows newest rows and expanded native scrolling sends no updates", async t => {
  const { bridge, layouts, texts } = bridgeRecorder();
  const working: RuntimeState = { ...runtime("", "S1"), main: { status: "running" }, transcript: [
    { id: 1, at: 1, role: "user", text: "Previous task" },
    { id: 2, at: 2, role: "assistant", text: Array.from({ length: 18 }, (_, index) => `Context line ${index + 1}: earlier result.`).join("\n") },
    { id: 3, at: 3, role: "user", text: "Continue on desktop" },
  ] };
  const display = new G2Display(() => {}, () => {}, {
    list: async () => sessions(), open: async () => working,
  }, { renderer });
  t.after(() => display.dispose()); display.update(runtime(), true); await display.init(bridge as any); await wait();
  await display.openSessions(); await wait();
  display.handleEvent({ listEvent: { currentSelectItemIndex: 1 } } as any); await wait();
  const body = pageText(layouts.at(-1));
  assert.ok(body.indexOf("Continue on desktop") < body.indexOf("Context line 1:"), "newest row appears first");
  assert.equal(layouts.at(-1).listObject[0].itemContainer.itemName[0], "+ New prompt");
  display.scroll(1); display.scroll(1); display.toggle(); await wait();
  const expanded = layouts.at(-1).textObject.find((item: any) => item.containerID === 1);
  assert.equal(expanded.isEventCapture, 1); assert.match(expanded.content, /Context line 1:/); assert.match(expanded.content, /Context line 18:/);
  const layoutCount = layouts.length, textCount = texts.length;
  for (let i = 0; i < 20; i++) display.handleEvent({ textEvent: { eventType: i % 2 + 1, containerID: 1 } } as any);
  await wait(); assert.equal(texts.length, textCount); assert.equal(layouts.length, layoutCount);
  display.update({ ...working, assistantOpen: true, currentAssistantText: "A new live update" }, true); await wait();
  assert.equal(texts.length, textCount); assert.equal(layouts.length, layoutCount);
  display.back(); await wait(); display.scroll(-1); display.scroll(-1); await wait();
  assert.match(pageText(layouts.at(-1)), /A new live update/);
});

test("the first history snapshot automatically replaces an empty native list without Refresh", async t => {
  const { bridge, layouts } = bridgeRecorder();
  const display = new G2Display(() => {}, () => {}, undefined, { renderer });
  t.after(() => display.dispose());
  display.update({ ...runtime(""), main: { status: "running" } }, true); await display.init(bridge as any); await wait();
  display.handleEvent({ textEvent: { eventType: 1 } } as any);
  display.update({ ...runtime("The first visible reply"), main: { status: "running" }, assistantOpen: true }, true); await wait(350);
  assert.match(pageText(layouts.at(-1)), /The first visible reply/);
  const count = layouts.length;
  display.update({ ...runtime("The next streaming update"), main: { status: "running" }, assistantOpen: true }, true); await wait(350);
  assert.equal(layouts.length, count, "once a readable snapshot is mounted, streaming still preserves focus");
});
