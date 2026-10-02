import { pageText } from "./helpers/g2-page.js";
import test from "node:test";
import assert from "node:assert/strict";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { initialState } from "../packages/cockpit-state/types.js";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import { getTextWidth } from "@evenrealities/pretext";

const wait = (ms = 140) => new Promise(resolve => setTimeout(resolve, ms));
const state = () => ({ ...initialState(), connected: true, session: { key: "S1", name: "Fixture", cwd: "fixture" }, currentAssistantText: "Current reply" });
function fixture() {
  const texts: string[] = [], footers: string[] = [], layouts: unknown[] = [], statuses: string[] = [];
  let ready = 0, preview = "";
  let deviceEvent: (status: any) => void = () => {};
  const bridge = {
    createStartUpPageContainer: async (page: unknown) => { layouts.push(page); return 0; },
    rebuildPageContainer: async (page: unknown) => { layouts.push(page); return true; },
    textContainerUpgrade: async (update: any) => { (update.containerID === 7 ? footers : texts).push(update.content); return true; },
    updateImageRawData: async () => "success", onEvenHubEvent: () => () => {},
    onDeviceStatusChanged: (cb: any) => { deviceEvent = cb; return () => {}; },
    getDeviceInfo: async () => ({ sn: "synthetic-g2", model: "g2", status: { sn: "synthetic-g2", connectType: "connected" } }),
  };
  const display = new G2Display((_, body) => { preview = body; }, value => statuses.push(value), undefined, { ready: () => { ready++; }, renderer: { pages: text => [text], render: frame => { footers.push(frame.footer); return []; } } });
  return { bridge, display, texts, footers, layouts, statuses, preview: () => preview, ready: () => ready, device: (connectType: string, sn = "synthetic-g2") => deviceEvent({ sn, connectType }) };
}

test("mixed conversation pages keep a native text region without sacrificing wide labels or swipe ownership", async t => {
  const f = fixture(), pages: any[] = [];
  t.after(() => f.display.dispose());
  f.bridge.createStartUpPageContainer = async (page: any) => {
    pages.push(page);
    // Mirrors the structural requirement observed in other apps; hardware
    // acceptance still needs a device check, not just this transport model.
    return page.textObject?.length ? 0 : 1;
  };
  f.display.update({ ...state(), currentAssistantText: "这是需要用满一整行的中文原生列表内容。".repeat(5) }, true);
  await f.display.init(f.bridge as any); await wait();
  assert.equal(pages.length, 1); assert.equal(f.statuses.at(-1), "G2 connected");
  const page = pages[0], row = page.listObject[0].itemContainer.itemName[1];
  assert.ok(Buffer.byteLength(row) > 63); assert.ok(getTextWidth(row) > 500);
  assert.deepEqual(validateEvenHubPageContainer(page), { valid: true });
  assert.equal(page.textObject[0].isEventCapture, 0);
  assert.equal(page.listObject[0].isEventCapture, 1);
  const before = pages.length;
  f.display.handleEvent({ listEvent: { eventType: 2, containerID: 8, currentSelectItemIndex: 1 } } as any); await wait();
  assert.equal(pages.length, before);
});

test("basic-view heading uses text pixel width rather than the list-label byte limit", async t => {
  const f = fixture(), pages: any[] = [];
  t.after(() => f.display.dispose());
  f.bridge.createStartUpPageContainer = async (page: any) => { pages.push(page); return page.imageObject?.length ? 1 : 0; };
  f.bridge.rebuildPageContainer = async (page: any) => { pages.push(page); return true; };
  f.display.update({ ...state(), source: { id: "fixture", name: "nuc", nameSource: "tailscale", online: true }, main: { status: "running" },
    session: { key: "S1", cwd: "fixture", tunnel: "pi", model: "deepseek/deepseek-v4-pro", name: "接手项目并继续整理历史文档和工作计划" } }, true);
  await f.display.init(f.bridge as any); await wait();
  const heading = pages.at(-1).textObject.find((text: any) => text.containerID === 6).content;
  assert.match(heading, /^nuc · agents: 1 \| Pi · deepseek-v4-pro \| 接手项目/);
  assert.ok(Buffer.byteLength(heading) > 63);
  assert.ok(getTextWidth(heading) <= 560); assert.ok(getTextWidth(heading) > 530);
  assert.doesNotMatch(heading, /agents: 1 \.\.\./);
});

test("network reconnection clears the footer notice without replacing the native message", async t => {
  const f = fixture(); t.after(() => f.display.dispose());
  f.display.update(state(), false); await f.display.init(f.bridge as any); await wait();
  assert.match(f.preview(), /reconnecting/); const writes = f.texts.length;
  f.display.update(state(), true); await wait();
  assert.match(f.preview(), /Current reply/); assert.match(f.preview(), /idle/); assert.doesNotMatch(f.preview(), /reconnecting/);
  assert.equal(f.texts.length, writes);
  assert.match(f.footers.at(-1)!, /idle/);
});

test("G2 link recovery resends unchanged state; ring and battery events do not reset the display", async t => {
  const f = fixture(); t.after(() => f.display.dispose());
  f.display.update(state(), true); await f.display.init(f.bridge as any); await wait();
  const before = f.layouts.length;
  f.device("disconnected", "synthetic-ring"); f.device("connected"); await wait();
  assert.equal(f.layouts.length, before);
  f.device("disconnected"); f.display.update(state(), true); await wait();
  f.device("connected"); await wait();
  assert.equal(f.layouts.length, before + 1); assert.equal(f.statuses.at(-1), "G2 connected");
  f.display.resync(); await wait();
  assert.match(pageText(f.layouts.at(-1)), /Current reply/); assert.match(pageText(f.layouts.at(-1)), /New prompt/); assert.equal(f.layouts.length, before + 1);
});

test("a failed first page does not block phone storage setup and page creation can recover", async t => {
  const f = fixture(); t.after(() => f.display.dispose());
  let attempts = 0;
  f.bridge.createStartUpPageContainer = async page => { attempts++; if (attempts <= 3) return 1; f.layouts.push(page); return 0; };
  f.display.update(state(), true); await f.display.init(f.bridge as any);
  assert.ok(f.statuses.some(value => /G2 display retrying · create: invalid \(1\)/.test(value)));
  assert.equal(f.ready(), 1, "phone bridge/storage setup runs even if the first glasses page fails");
  f.display.resync(); await wait();
  assert.equal(attempts, 4); assert.match(f.statuses.at(-1)!, /G2 connected · basic view/);
  assert.equal(f.ready(), 1);
});

test("rejected rich pages recover to a visible native list and readable messages without image writes", async t => {
  for (const code of [1, 2, 3]) {
    const f = fixture(), attempted: any[] = []; let images = 0;
    t.after(() => f.display.dispose());
    const check = (page: any) => {
      assert.deepEqual(validateEvenHubPageContainer(page), { valid: true });
      attempted.push(page);
      return page.containerTotalNum <= 3;
    };
    f.bridge.createStartUpPageContainer = async page => check(page) ? 0 : code;
    f.bridge.rebuildPageContainer = async page => check(page);
    f.bridge.updateImageRawData = async () => { images++; return "success"; };
    f.display.update({ ...state(), currentAssistantText: "", transcript: [
      { id: 1, at: 1, role: "user", text: "Question" },
      { id: 2, at: 2, role: "assistant", text: "Complete answer" },
    ] }, true);
    await f.display.init(f.bridge as any); await wait();
    const startupAttempts = code === 1 ? 3 : 2;
    assert.equal(attempted.length, startupAttempts); assert.equal(attempted[0].containerTotalNum, 6);
    const list = attempted.at(-1).listObject[0];
    assert.deepEqual(list.itemContainer.itemName, ["+ New prompt", "← Complete answer", "→ Question"]);
    assert.deepEqual([list.width, list.height], [560, 222]);
    assert.match(f.statuses.at(-1)!, new RegExp(`G2 connected · basic view .*\\(${code}\\)`));
    f.display.handleEvent({ listEvent: { containerID: 8, eventType: 2, currentSelectItemIndex: 1 } } as any);
    await wait(); assert.equal(attempted.length, startupAttempts, "selection must not rebuild the native list");
    f.display.handleEvent({ listEvent: { containerID: 8, currentSelectItemIndex: 1 } } as any); await wait();
    const detail = attempted.at(-1);
    assert.equal(detail.containerTotalNum, 3); assert.equal(detail.textObject.find((item: any) => item.containerID === 1).content, "Complete answer");
    assert.equal(detail.textObject.find((item: any) => item.containerID === 1).isEventCapture, 1); assert.equal(images, 0);
    const before = attempted.length, writes = f.texts.length;
    f.display.handleEvent({ textEvent: { eventType: 2, containerID: 1 } } as any); await wait();
    assert.equal(attempted.length, before); assert.equal(f.texts.length, writes);
    f.display.handleEvent({ textEvent: { eventType: 3 } } as any); await wait();
    assert.ok(attempted.at(-1).listObject); assert.match(f.preview(), /^> \+ New prompt/);
    f.device("disconnected"); f.device("connected"); await wait();
    assert.ok(attempted.slice(startupAttempts - 1).every(page => page.containerTotalNum <= 3), "reconnect keeps the working layout instead of retrying the rejected one");
  }
});

test("a rejected rebuild switches frames before sending any obsolete rich-page images", async t => {
  const f = fixture(), pages: any[] = [], writes: number[] = []; let images = 0;
  t.after(() => f.display.dispose());
  f.bridge.rebuildPageContainer = async (page: any) => { pages.push(page); return page.containerTotalNum <= 3; };
  f.bridge.textContainerUpgrade = async update => { writes.push(update.containerID); return true; };
  f.bridge.updateImageRawData = async () => { images++; return "success"; };
  f.display.update(state(), true); await f.display.init(f.bridge as any); await wait();
  writes.length = 0;
  f.display.update({ ...state(), currentAssistantText: "", transcript: [{ id: 1, at: 1, role: "user", text: "New question" }] }, true);
  f.display.back();
  await wait(350);
  assert.deepEqual(pages.map(page => page.containerTotalNum), [6, 2, 3]);
  assert.match(f.statuses.at(-1)!, /basic view \(rebuild rejected; no-images: OK\)/);
  assert.deepEqual(writes, []); assert.equal(images, 0);
});

test("a label-length rejection only compacts labels, preserving header images and full message reading", async t => {
  const f = fixture(), attempts: any[] = [];
  t.after(() => f.display.dispose());
  const accepts = (page: any) => {
    attempts.push(page);
    return (page.listObject || []).every((list: any) => list.itemContainer.itemName.every((label: string) => Buffer.byteLength(label) <= 63));
  };
  f.bridge.createStartUpPageContainer = async page => accepts(page) ? 0 : 1;
  f.bridge.rebuildPageContainer = async page => accepts(page);
  const text = "这是一段应该用满列表行宽的中文回复。".repeat(6);
  f.display.update({ ...state(), currentAssistantText: text }, true);
  await f.display.init(f.bridge as any); await wait();
  assert.deepEqual(attempts.map(page => page.containerTotalNum), [6, 6]);
  assert.ok(Buffer.byteLength(attempts[0].listObject[0].itemContainer.itemName[1]) > 63);
  const fallback = attempts.at(-1).listObject[0];
  assert.equal(fallback.itemContainer.itemWidth, fallback.width);
  assert.ok(fallback.itemContainer.itemName.every((label: string) => Buffer.byteLength(label) <= 63));
  assert.match(fallback.itemContainer.itemName[1], /^← .*\.\.\.$/);
  assert.deepEqual(attempts[1].imageObject, attempts[0].imageObject);
  assert.match(f.statuses.at(-1)!, /G2 connected · compact labels/);
  f.display.handleEvent({ listEvent: { containerID: 8, currentSelectItemIndex: 1 } } as any);
  await wait();
  assert.equal(pageText(attempts.at(-1)), text);
  f.display.handleEvent({ textEvent: { eventType: 3 } } as any); await wait();
  assert.ok(attempts.at(-1).listObject);
  assert.match(f.statuses.at(-1)!, /G2 connected · compact labels/);
  assert.ok(attempts.every(page => page.imageObject.length === 4), "native label limits never replace the small status bars");
});

test("rejected mixed pages do not force compact labels on a working native text/list page", async t => {
  for (const byteLimited of [false, true]) {
    const f = fixture(), pages: any[] = [];
    t.after(() => f.display.dispose());
    const accept = (page: any) => {
      pages.push(page);
      return page.containerTotalNum === 3 && (!byteLimited || page.listObject[0].itemContainer.itemName.every((label: string) => Buffer.byteLength(label) <= 63));
    };
    f.bridge.createStartUpPageContainer = async (page: any) => accept(page) ? 0 : 1;
    f.bridge.rebuildPageContainer = async (page: any) => accept(page);
    f.display.update({ ...state(), currentAssistantText: "这段历史内容应当完整使用原生列表的行宽。".repeat(5) }, true);
    await f.display.init(f.bridge as any); await wait();
    assert.deepEqual(pages.map(page => page.containerTotalNum), byteLimited ? [6, 6, 2, 3, 3] : [6, 6, 2, 3]);
    const label = pages.at(-1).listObject[0].itemContainer.itemName[1];
    assert.equal(Buffer.byteLength(label) <= 63, byteLimited);
    assert.equal(f.statuses.at(-1)!.includes("compact labels"), byteLimited);
    f.device("disconnected"); f.device("connected"); await wait();
    assert.equal(pages.at(-1).containerTotalNum, 3);
    assert.equal(pages.at(-1).listObject[0].itemContainer.itemName[1], label);
  }
});

test("opening before the phone connects shows a connection notice then existing session history automatically", async t => {
  const f = fixture(); t.after(() => f.display.dispose());
  await f.display.init(f.bridge as any); await wait();
  assert.match(pageText(f.layouts.at(-1)), /Connecting to desktop/);
  assert.equal((f.layouts.at(-1) as any).listObject, undefined);
  f.display.update({ ...state(), currentAssistantText: "", transcript: [] }, true); await wait();
  f.display.update({ ...state(), currentAssistantText: "", transcript: [
    { id: 1, at: 1, role: "user", text: "Existing question" },
    { id: 2, at: 2, role: "assistant", text: "Existing answer" },
  ] }, true); await wait(350);
  const labels = (f.layouts.at(-1) as any).listObject[0].itemContainer.itemName;
  assert.deepEqual(labels, ["+ New prompt", "← Existing answer", "→ Existing question"]);
  const count = f.layouts.length;
  f.display.handleEvent({ listEvent: { containerID: 8, eventType: 2, currentSelectItemIndex: 2 } } as any);
  f.display.update({ ...state(), transcript: [
    { id: 1, at: 1, role: "user", text: "Existing question" },
    { id: 2, at: 2, role: "assistant", text: "Existing answer" },
    { id: 3, at: 3, role: "assistant", text: "New arrival" },
  ] }, true); await wait(350);
  assert.equal(f.layouts.length, count, "incoming replies do not replace rows being browsed");
  f.display.handleEvent({ listEvent: { containerID: 8, currentSelectItemIndex: 2 } } as any); await wait();
  assert.equal(pageText(f.layouts.at(-1)), "Existing question");
});

test("a long-label rebuild retries the same rich layout once and retains compact labels on reconnection", async t => {
  const f = fixture(), attempts: any[] = [];
  t.after(() => f.display.dispose());
  f.display.update(state(), true); await f.display.init(f.bridge as any); await wait();
  f.bridge.rebuildPageContainer = async (page: any) => {
    attempts.push(page);
    return (page.listObject || []).every((list: any) => list.itemContainer.itemName.every((label: string) => Buffer.byteLength(label) <= 63));
  };
  f.display.update({ ...state(), currentAssistantText: "这是已有会话里的一段长中文回复。".repeat(20) }, true);
  f.display.back(); await wait();
  assert.deepEqual(attempts.map(page => page.containerTotalNum), [6, 6]);
  assert.deepEqual(attempts[0].imageObject, attempts[1].imageObject);
  assert.match(f.statuses.at(-1)!, /compact labels/);
  f.device("disconnected"); f.device("connected"); await wait();
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[2].listObject, attempts[1].listObject);
});

test("sparse image tiles fit documented image bounds and replace the oversized native footer", async t => {
  const f = fixture(), pages: any[] = [];
  t.after(() => f.display.dispose());
  f.bridge.createStartUpPageContainer = async (page: any) => {
    pages.push(page);
    return page.imageObject.some((image: any) => image.width > 288 || image.height > 144) ? 1 : 0;
  };
  f.display.update(state(), true); await f.display.init(f.bridge as any); await wait();
  assert.equal(pages.length, 1); assert.equal(f.statuses.at(-1), "G2 connected");
  assert.equal(pages[0].imageObject.reduce((sum: number, image: any) => sum + image.width * image.height, 0), 576 * 60);
  assert.equal(pages[0].textObject.some((item: any) => item.containerID === 7), false);
});

test("the image-free comparison changes only images and a successful probe is followed by rebuild, never a second successful create", async t => {
  const f = fixture(), creates: any[] = [], rebuilds: any[] = [];
  t.after(() => f.display.dispose());
  f.bridge.createStartUpPageContainer = async (page: any) => { creates.push(page); return page.imageObject?.length ? 1 : 0; };
  f.bridge.rebuildPageContainer = async (page: any) => { rebuilds.push(page); return true; };
  f.display.update(state(), true); await f.display.init(f.bridge as any); await wait();
  assert.equal(creates.length, 2); assert.deepEqual(creates[1].textObject, creates[0].textObject);
  assert.deepEqual(creates[1].listObject, creates[0].listObject);
  assert.deepEqual(creates[1].imageObject, []); assert.equal(creates[1].containerTotalNum, 2);
  assert.equal(rebuilds.length, 1); assert.equal(rebuilds[0].containerTotalNum, 3);
  assert.match(f.statuses.at(-1)!, /no-images: OK/);
  f.display.resync(true); await wait();
  assert.equal(creates.length, 2); assert.ok(rebuilds.every(page => page.containerTotalNum === 3));
});

test("transport exceptions report the failing bridge and do not silently downgrade the layout", async t => {
  const f = fixture(); let attempts = 0;
  t.after(() => f.display.dispose());
  f.bridge.createStartUpPageContainer = async () => { attempts++; throw new Error("Unavailable transport"); };
  f.display.update(state(), true); await f.display.init(f.bridge as any); await wait();
  assert.equal(attempts, 1, "normal backoff prevents a tight retry loop");
  assert.equal(f.statuses.at(-1), "G2 display retrying · bridge request failed");
});

test("diagnostic pages cannot forward task controls and exiting during the comparison cannot restore a page", async t => {
  for (const exitDuringProbe of [false, true]) {
    let enter!: () => void, release!: () => void, stops = 0, inputs = 0, rebuilds = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const statuses: string[] = [];
    const display = new G2Display(() => {}, value => statuses.push(value), undefined, {
      renderer: { pages: text => [text], render: () => [] },
      interrupt: async () => { stops++; }, input: { open: () => { inputs++; }, toggleRecording() {} },
    });
    t.after(() => { release(); display.dispose(); });
    display.update({ ...state(), main: { status: "running" } }, true);
    const mounting = display.init({
      onEvenHubEvent: () => () => {},
      createStartUpPageContainer: async (page: any) => {
        if (page.imageObject?.length) return 1;
        enter(); await held; return 0;
      },
      rebuildPageContainer: async () => { rebuilds++; return true; },
    } as any);
    await entered;
    display.handleEvent({ menuItemClickEvent: { itemID: 4 } } as any);
    display.handleEvent({ menuItemClickEvent: { itemID: 7 } } as any);
    if (exitDuringProbe) display.handleEvent({ sysEvent: { eventType: 7 } } as any);
    release(); await mounting;
    assert.equal(stops, 0); assert.equal(inputs, 0);
    assert.equal(rebuilds, exitDuringProbe ? 0 : 1);
    assert.match(statuses.at(-1)!, exitDuringProbe ? /^G2 disconnected$/ : /basic view/);
  }
});
