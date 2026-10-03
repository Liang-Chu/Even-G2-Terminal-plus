import test from "node:test";
import assert from "node:assert/strict";
import { ImageRawDataUpdate } from "@evenrealities/even_hub_sdk";
import { bridgeBatch, serialBridge } from "../apps/evenhub/src/bridge/serial.js";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { initialState } from "../packages/cockpit-state/types.js";

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

test("host requests from separate consumers serialize, preserve binding, and recover after rejection", async () => {
  let active = 0, peak = 0;
  const order: string[] = [], token = {}, unsubscribe = () => {};
  const request = async (name: string) => {
    peak = Math.max(peak, ++active); order.push(name);
    await wait(); active--;
    if (name === "bad image") throw new Error("Rejected");
    return name;
  };
  const raw = {
    token,
    getLocalStorage(this: any, key: string) { assert.equal(this.token, token); return request(key); },
    textContainerUpgrade: () => request("text"),
    updateImageRawData: () => request("bad image"),
    audioControl: () => request("microphone"),
    setLocalStorage: () => request("save"),
    onEvenHubEvent: () => unsubscribe,
  };
  const bridge = serialBridge(raw as any);
  assert.equal(serialBridge(raw as any), bridge); assert.equal(serialBridge(bridge), bridge);
  assert.equal(bridge.onEvenHubEvent(() => {}), unsubscribe, "subscriptions stay synchronous");
  const result = await Promise.allSettled([
    bridge.getLocalStorage("connection"), bridge.textContainerUpgrade({} as any),
    bridge.updateImageRawData({} as any), bridge.audioControl(false), bridge.setLocalStorage("key", "value"),
  ]);
  assert.equal(peak, 1); assert.deepEqual(order, ["connection", "text", "bad image", "microphone", "save"]);
  assert.equal(result[2].status, "rejected"); assert.equal(result[4].status, "fulfilled");
});

test("startup and later rendering cannot overlap settings, device or microphone requests", async t => {
  let active = 0, peak = 0;
  const calls: string[] = [], pending: Promise<unknown>[] = [];
  const request = async <T>(name: string, value: T) => {
    peak = Math.max(peak, ++active); calls.push(name); await wait(); active--; return value;
  };
  const raw = {
    createStartUpPageContainer: () => request("create", 0),
    rebuildPageContainer: () => request("rebuild", true),
    textContainerUpgrade: () => request("text", true),
    updateImageRawData: () => request("image", "success"),
    getLocalStorage: () => request("settings", ""),
    setLocalStorage: () => request("save", true),
    getDeviceInfo: () => request("device", null),
    audioControl: () => request("microphone", true),
    onEvenHubEvent: () => () => {},
  };
  let consumer: ReturnType<typeof serialBridge>;
  const display = new G2Display(() => {}, () => {}, undefined, {
    renderer: { pages: text => [text], render: () => [{ id: 2, name: "pilot-img-0", png: "data:image/png;base64,AA==" }] },
    ready: bridge => {
      assert.equal(active, 0);
      assert.deepEqual(calls, ["create"], "phone consumers attach after startup finishes");
      consumer = bridge;
      pending.push(bridge.getLocalStorage("connection"), bridge.getLocalStorage("voice"), bridge.setLocalStorage("key", "value"));
    },
  });
  t.after(() => display.dispose());
  await display.init(raw as any);
  display.update({ ...initialState(), connected: true, session: { key: "fixture", cwd: "fixture" }, currentAssistantText: "Existing reply" }, true);
  pending.push(consumer!.audioControl(false));
  await Promise.all(pending); await wait(100);
  assert.equal(peak, 1); assert.ok(calls.includes("image")); assert.ok(calls.includes("device"));
});

test("a status-bar batch stays consecutive and releases queued controls even after failure", async () => {
  const calls: string[] = []; let active = 0, peak = 0;
  const request = async (label: string) => {
    peak = Math.max(peak, ++active); calls.push(label); await wait(); active--;
    if (label === "bad") throw new Error("Rejected tile");
    return "success";
  };
  const raw = { updateImageRawData: (image: any) => request(image.containerName), audioControl: () => request("mic") };
  const bridge = serialBridge(raw as any);
  const result = await Promise.allSettled([
    bridgeBatch(bridge, async direct => {
      await direct.updateImageRawData(new ImageRawDataUpdate({ containerName: "left" }));
      await direct.updateImageRawData(new ImageRawDataUpdate({ containerName: "right" }));
    }),
    bridge.audioControl(false),
    bridgeBatch(bridge, async direct => { await direct.updateImageRawData(new ImageRawDataUpdate({ containerName: "bad" })); }),
    bridge.audioControl(false),
  ]);
  assert.deepEqual(calls, ["left", "right", "mic", "bad", "mic"]);
  assert.equal(peak, 1); assert.equal(result[2].status, "rejected"); assert.equal(result[3].status, "fulfilled");
});

test("editor transcription does not strand half a header and settings wait only until the bar completes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  const calls: string[] = []; let pauseLeft = false, release!: () => void;
  let consumer!: ReturnType<typeof serialBridge>;
  const raw = {
    onEvenHubEvent: () => () => {},
    createStartUpPageContainer: async () => { calls.push("create"); return 0; },
    rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
    textContainerUpgrade: async () => { calls.push("text"); return true; },
    getLocalStorage: async () => { calls.push("settings"); return ""; },
    updateImageRawData: async (tile: any) => {
      calls.push(`image:${tile.containerID}`);
      if (pauseLeft && tile.containerID === 2) { pauseLeft = false; await new Promise<void>(resolve => { release = resolve; }); }
      return "success";
    },
  };
  const display = new G2Display(() => {}, () => {}, undefined, {
    ready: bridge => { consumer = bridge; },
    renderer: { pages: text => [text], render: () => {
      calls.push("encode");
      return [2, 3, 4, 5].map(id => ({ id, name: `tile-${id}`, png: "data:image/png;base64,AA==" }));
    } },
  });
  t.after(() => { release?.(); display.dispose(); });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
  display.update({ ...initialState(), connected: true, session: { key: "fixture", cwd: "fixture" } }, true);
  await display.init(raw as any); await advance(60);
  assert.ok(calls.indexOf("encode") < calls.indexOf("create"));
  calls.length = 0; pauseLeft = true;
  display.setComposer({ text: "First sentence", hint: "Tap: record" }); await advance(60);
  assert.deepEqual(calls, ["encode", "rebuild", "image:2"]);
  const settings = consumer.getLocalStorage("speech");
  display.setComposer({ text: "First sentence. Second sentence.", hint: "Tap: record" });
  release(); await advance(0); await settings;
  assert.deepEqual(calls.slice(2), ["image:2", "image:3", "settings", "image:4", "image:5"]);
  calls.length = 0; await advance(60);
  assert.ok(calls.includes("text"), "latest transcription still arrives in the next coalesced update");
  assert.ok(!calls.some(call => call.startsWith("image:")), "the next body update does not resend identical bars");
});

test("queued text is skipped after leaving its page or replacing its content", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  for (const leavePage of [false, true]) {
    const texts: string[] = [], pages: any[] = [];
    let release!: () => void, consumer!: ReturnType<typeof serialBridge>;
    const raw = {
      onEvenHubEvent: () => () => {},
      createStartUpPageContainer: async (page: any) => { pages.push(page); return 0; },
      rebuildPageContainer: async (page: any) => { pages.push(page); return true; },
      textContainerUpgrade: async (update: any) => { texts.push(update.content); return true; },
      getLocalStorage: () => new Promise<string>(resolve => { release = () => resolve(""); }),
    };
    const display = new G2Display(() => {}, () => {}, undefined, {
      ready: bridge => { consumer = bridge; }, renderer: { pages: text => [text], render: () => [] },
    });
    t.after(() => { release?.(); display.dispose(); });
    const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
    display.update({ ...initialState(), connected: true, session: { key: "fixture", cwd: "fixture" } }, true);
    display.setComposer({ text: "Original draft", hint: "Tap: record" });
    await display.init(raw as any); await advance(60);
    const blocked = consumer.getLocalStorage("settings"); await advance(0);
    display.setComposer({ text: "Obsolete draft", hint: "Tap: record" }); await advance(60);
    assert.equal(texts.length, 0, "the text request waits behind the host request");
    if (leavePage) display.back();
    else display.setComposer({ text: "Latest draft", hint: "Tap: record" });
    release(); await blocked; await advance(0); await advance(60);
    assert.ok(!texts.includes("Obsolete draft"), "an obsolete queued update never reaches the SDK");
    if (leavePage) assert.ok(pages.at(-1).listObject, "Back still mounts the conversation page");
    else assert.deepEqual(texts, ["Latest draft"], "the newest body arrives in the next flush");
    display.dispose();
  }
});

test("session navigation sends its page and bars before a slow remembered-session save", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  const calls: string[] = [], viewed: (string | undefined)[] = [];
  let release!: () => void;
  const state = (key: string) => ({ ...initialState(), connected: true, session: { key, cwd: "fixture" }, currentAssistantText: `${key} reply` });
  const bridge = {
    onEvenHubEvent: () => () => {},
    createStartUpPageContainer: async () => { calls.push("create"); return 0; },
    rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
    textContainerUpgrade: async () => { calls.push("text"); return true; },
    updateImageRawData: async (tile: any) => { calls.push(`image:${tile.containerID}`); return "success"; },
    getLocalStorage: async () => "fixture",
    setLocalStorage: async (_storageKey: string, key: string) => {
      calls.push(`save:${key}`);
      if (key === "other") await new Promise<void>(resolve => { release = resolve; });
      return true;
    },
  };
  const display = new G2Display(() => {}, () => {}, {
    list: async () => ["fixture", "other"].map((key, index) => ({ key, id: key, cwd: "fixture", name: key,
      monitored: true, runtimeStatus: "idle" as const, updatedAt: 2 - index })),
    open: async key => state(key),
  }, {
    viewed: key => viewed.push(key),
    renderer: { pages: text => [text], render: () => [2, 3, 4, 5].map(id => ({ id, name: `tile-${id}`, png: "data:image/png;base64,AA==" })) },
  });
  t.after(() => { release?.(); display.dispose(); });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
  display.update(state("fixture"), true); await display.init(bridge as any); await advance(60);
  await display.openSessions(); await advance(60); calls.length = 0;
  display.scroll(1); await display.selectSession();
  assert.equal(viewed.at(-1), undefined, "the new session is not viewed before its page acknowledgement");
  await advance(60);
  assert.deepEqual(calls, ["rebuild", "image:2", "image:3", "image:4", "image:5", "save:other"]);
  assert.equal(viewed.at(-1), "other", "saving preferences does not delay the acknowledged new page");
  release(); await advance(0);
});

test("a pending remembered session keeps its captured scope and survives pause, failure and disposal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  for (const finish of ["scope", "pause", "failure", "dispose"] as const) {
    const saves: string[][] = [];
    let rejectPage = false;
    const state = (key: string) => ({ ...initialState(), connected: true, session: { key, cwd: "fixture" } });
    const bridge = {
      onEvenHubEvent: () => () => {}, createStartUpPageContainer: async () => 0,
      rebuildPageContainer: async () => { if (rejectPage) throw new Error("Transport failure"); return true; },
      textContainerUpgrade: async () => true, getLocalStorage: async () => "fixture",
      setLocalStorage: async (storageKey: string, key: string) => { saves.push([storageKey, key]); return true; },
    };
    const display = new G2Display(() => {}, () => {}, {
      list: async () => [{ key: "fixture", id: "fixture", cwd: "fixture", monitored: true, runtimeStatus: "idle" }],
      open: async key => state(key),
    }, { renderer: { pages: text => [text], render: () => [] } });
    t.after(() => display.dispose());
    const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
    display.update(state("fixture"), true); await display.init(bridge as any); await advance(60); await advance(60); saves.length = 0;
    display.update(state("other"), true);
    assert.deepEqual(saves, [], "remembering awaits the next page flush");
    if (finish === "scope") display.setStorageScope("new-scope");
    else if (finish === "pause") display.handleEvent({ sysEvent: { eventType: 4 } } as any);
    else if (finish === "failure") { rejectPage = true; await advance(60); }
    else display.dispose();
    await advance(0);
    assert.deepEqual(saves, [["pilot.last-session.default", "other"]], `${finish} must not discard or rescope the save`);
    display.dispose();
  }
});

test("rapid session changes save the newest key after its page, even behind an obsolete image flush", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  const calls: string[] = [], saves: string[] = [];
  let blockImage = false, release!: () => void;
  const state = (key: string, running = false) => ({ ...initialState(), connected: true,
    session: { key, cwd: "fixture" }, main: { status: running ? "running" as const : "idle" as const }, currentAssistantText: `${key} reply` });
  const bridge = {
    onEvenHubEvent: () => () => {}, createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async (page: any) => { calls.push(`rebuild:${page.listObject?.[0].itemContainer.itemName.at(-1)}`); return true; },
    textContainerUpgrade: async () => true, getLocalStorage: async () => "fixture",
    setLocalStorage: async (_storageKey: string, key: string) => { calls.push(`save:${key}`); saves.push(key); return true; },
    updateImageRawData: async () => {
      calls.push("image");
      if (blockImage) { blockImage = false; await new Promise<void>(resolve => { release = resolve; }); }
      return "success";
    },
  };
  const display = new G2Display(() => {}, () => {}, {
    list: async () => [{ key: "fixture", id: "fixture", cwd: "fixture", monitored: true, runtimeStatus: "idle" }],
    open: async key => state(key),
  }, { renderer: { pages: text => [text], render: frame => [{ id: 2, name: "tile-0",
    png: `data:image/png;base64,${Buffer.from(frame.prefix + frame.title).toString("base64")}` }] } });
  t.after(() => { release?.(); display.dispose(); });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
  display.update(state("fixture"), true); await display.init(bridge as any); await advance(60); await advance(60);
  saves.length = 0; calls.length = 0; blockImage = true;
  display.update(state("fixture", true), true); await advance(60);
  assert.deepEqual(calls, ["image"]);
  display.update(state("intermediate"), true); display.update(state("newest"), true);
  release(); await advance(0);
  assert.equal(saves.length, 0, "the obsolete flush cannot save ahead of the newest page");
  await advance(60);
  assert.deepEqual(saves, ["newest"], "unsent saves in the same scope collapse to the newest selection");
  assert.match(calls[1], /^rebuild:.*newest reply$/);
  assert.deepEqual(calls.slice(2), ["image", "save:newest"]);
});
