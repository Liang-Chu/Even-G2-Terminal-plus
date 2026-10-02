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
