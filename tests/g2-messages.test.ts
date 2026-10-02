import test from "node:test";
import assert from "node:assert/strict";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import { MessageBrowser, messageLabel, listLabel, LIST_ROW_WIDTH, LIST_TEXT_WIDTH, messageParts, NATIVE_TEXT_BYTES } from "../apps/evenhub/src/g2/messages.js";
import { getTextWidth, measureTextWrap } from "@evenrealities/pretext";
import { nativeLayout } from "../apps/evenhub/src/g2/native.js";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { glassesMessages, type G2Message } from "../packages/cockpit-state/g2-reply.js";
import { initialState } from "../packages/cockpit-state/types.js";
const message = (id: string, role: G2Message["role"] = "assistant", text = id): G2Message => ({ id, role, text });
const wait = () => new Promise(resolve => setTimeout(resolve, 140));

test("conversation uses one visible native list, top input and newest-first directional labels", () => {
  const browser = new MessageBrowser();
  browser.update({ messages: [message("latest", "user"), message("previous")], limited: false });
  const entries = browser.rows(true);
  assert.deepEqual(entries.map(row => row.label), ["+ New prompt", "→ latest", "← previous"]);
  const layout = nativeLayout({ layoutKey: "messages:s", body: "", entries, conversationList: true });
  assert.deepEqual(validateEvenHubPageContainer(layout), { valid: true });
  assert.equal(layout.containerTotalNum, 6); assert.equal(layout.textObject!.length, 1);
  const list = layout.listObject![0];
  assert.equal(list.isEventCapture, 1); assert.equal(list.itemContainer!.isItemSelectBorderEn, 1);
  assert.deepEqual(list.itemContainer!.itemName, entries.map(row => row.label));
  assert.equal(list.itemContainer!.itemWidth, LIST_ROW_WIDTH); assert.equal(list.width, LIST_ROW_WIDTH); assert.equal(list.borderWidth, 0);
  assert.ok("imageObject" in layout && layout.imageObject);
  assert.deepEqual(layout.imageObject.map(image => [image.xPosition,image.yPosition,image.width,image.height]),
    [[0,0,288,34],[288,0,288,34],[0,262,288,26],[288,262,288,26]]);
  assert.ok(layout.imageObject.every(image => image.yPosition! + image.height! <= list.yPosition! || image.yPosition! >= list.yPosition! + list.height!), "images never overlap the native list");
  assert.deepEqual(layout.menuObject.menuItems!.map(item => item.itemName), ["Terminate task", "Sessions"]);
});

test("each message stays on one firmware line and truncates within pixel and character limits", () => {
  for (const role of ["user", "assistant"] as const) for (const text of ["中文😀".repeat(200), "An ordinary English paragraph. ".repeat(100), "W".repeat(600)]) {
    const label = messageLabel(message("sample",role,text));
    assert.doesNotMatch(label, /[\r\n]/); assert.ok(label.includes("..."));
    assert.ok(label.length <= 64); assert.equal(Buffer.from(label).toString(), label);
    assert.ok(getTextWidth(label) <= LIST_TEXT_WIDTH);
    assert.equal(measureTextWrap(label, LIST_TEXT_WIDTH).lineCount, 1);
    assert.ok(label.startsWith(role === "assistant" ? "← " : "→ "));
  }
  const label = listLabel("Please improve navigation accessibility responsiveness documentation before publishing");
  const source = new Set("Please improve navigation accessibility responsiveness documentation before publishing".split(" "));
  assert.ok((label.match(/[A-Za-z]+/g) || []).every(word => source.has(word)));
  assert.equal(messageLabel(message("short","assistant","Hello")), "← Hello");
});

test("Chinese conversation rows fill the native width instead of being cut at 63 UTF-8 bytes", () => {
  for (const role of ["assistant", "user"] as const) {
    const sample = message("wide", role, "中".repeat(100));
    const label = messageLabel(sample), compact = messageLabel(sample, true);
    assert.ok(Buffer.byteLength(label) > 63);
    assert.ok(getTextWidth(label) <= LIST_TEXT_WIDTH);
    assert.ok(getTextWidth(label) > LIST_TEXT_WIDTH - getTextWidth("中"));
    assert.ok(label.endsWith("..."));
    assert.ok(Buffer.byteLength(compact) <= 63);
    assert.ok(getTextWidth(label) - getTextWidth(compact) >= 100);
  }
  const browser = new MessageBrowser();
  browser.update({ messages: [message("wide", "assistant", "中".repeat(100))], limited: false });
  const normal = browser.rows(true), compact = browser.rows(true, undefined, true);
  assert.notEqual(compact[1].label, normal[1].label);
  assert.deepEqual(compact.map(row => row.key), normal.map(row => row.key));
  assert.equal(browser.rows(true, undefined, true), compact, "fallback rows are cached separately");
  assert.deepEqual(browser.rows(true), normal);
});

test("UTF-8 bounded native message parts preserve the entire expanded response", () => {
  for(const text of ["中文😀".repeat(1800), "Paragraph. ".repeat(200), "x".repeat(1849)+"😀"+"y".repeat(2000)]) {
    const parts=messageParts(text);
    assert.equal(parts.join(""),text); assert.ok(parts.length>1);
    assert.ok(parts.every(part=>Buffer.byteLength(part)<=NATIVE_TEXT_BYTES && Buffer.from(part).toString()===part));
  }
});

test("long Chinese and emoji replies open with visible content in the first page operation", async t => {
  const pages: any[] = [], updates: any[] = [];
  const accept = (page: any) => {
    assert.deepEqual(validateEvenHubPageContainer(page), { valid: true });
    for (const text of page.textObject || []) assert.ok(Buffer.byteLength(text.content || "") <= 999);
    pages.push(page);
  };
  const bridge = {
    createStartUpPageContainer: async (page: any) => { accept(page); return 0; },
    rebuildPageContainer: async (page: any) => { accept(page); return true; },
    textContainerUpgrade: async (update: any) => { updates.push(update); return false; },
    updateImageRawData: async () => "success", onEvenHubEvent: () => () => {},
  };
  const display = new G2Display(() => {}, () => {}, undefined, { renderer: { pages: text => [text], render: () => [] } });
  t.after(() => display.dispose());
  const text = "这是一段需要展开阅读的长消息😀。".repeat(160);
  display.update({ ...initialState(), connected: true, session: { key: "s", cwd: "demo" }, currentAssistantText: text }, true);
  await display.init(bridge as any); await wait();
  display.scroll(1); display.toggle(); await wait();
  const detail = pages.at(-1).textObject.find((item: any) => item.containerID === 1);
  assert.match(detail.content, /^这是一段/); assert.equal(detail.isEventCapture, 1); assert.equal(detail.textColor, 4);
  assert.equal(updates.length, 0, "opening must not depend on a second text upgrade succeeding");
  assert.equal(messageParts(text).join(""), text);
});

test("native list holds the latest ten messages stable until returning to the list", () => {
  const history = glassesMessages({ ...initialState(), transcript: Array.from({ length:14 },(_,i)=>({id:i,at:i,role:i%2?"assistant" as const:"user" as const,text:"Message "+i})) });
  assert.equal(history.messages.length,10); assert.equal(history.limited,true);
  const browser=new MessageBrowser(); browser.update({...history,messages:history.messages.slice().reverse()}); browser.hold();
  const rows = browser.rows(true);
  browser.update({messages:[message("new")],limited:false});
  assert.equal(browser.rows(true), rows, "status and stream updates reuse fitted native labels");
  assert.equal(browser.rows(true).length,11); assert.equal(browser.messages[0].text,"Message 13"); assert.equal(browser.changed,true);
  browser.scroll(2); browser.open(); assert.equal(browser.detail!.message.text,"Message 12");
  browser.back(); browser.selectInput(); assert.equal(browser.messages[0].text,"new"); assert.equal(browser.changed,false);
});

test("single tap edits only the input row; detail double tap returns and list double tap confirms exit", async t => {
  let opens = 0, exits = 0, interrupts = 0, body = "";
  const bridge = {
    createStartUpPageContainer: async () => 0, rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true, updateImageRawData: async () => "success", onEvenHubEvent: () => () => {},
    shutDownPageContainer: async (mode: number) => { assert.equal(mode, 1); exits++; return true; },
  };
  const display = new G2Display((_, text) => { body = text; }, () => {}, undefined, {
    renderer: { pages: text => [text], render: () => [] },
    input: { open: () => opens++, toggleRecording() {} }, interrupt: async () => { interrupts++; },
  });
  t.after(() => display.dispose());
  display.update({ ...initialState(), connected: true, session: { key: "s", cwd: "test" }, currentAssistantText: "Complete response" }, true);
  await display.init(bridge as any); await wait();
  display.toggle(); assert.equal(opens, 1);
  display.scroll(1); display.toggle(); await wait();
  assert.equal(opens, 1); assert.match(body, /^Complete response/);
  display.handleEvent({ textEvent: { eventType: 3 } } as any); await wait();
  assert.equal(exits, 0); assert.match(body, /New prompt/);
  display.handleEvent({ textEvent: { eventType: 3 } } as any); await wait();
  assert.equal(exits, 1); assert.equal(interrupts, 0);
});

test("read-only Codex messages can expand without offering a working input action", t => {
  let opens = 0, body = "";
  const display = new G2Display((_, text) => { body = text; }, () => {}, undefined, {
    input: { open: () => opens++, toggleRecording() {} },
  });
  t.after(() => display.dispose());
  display.update({ ...initialState(), connected: true, session: { key: "s", cwd: "test", tunnel: "codex" },
    capabilities: { prompt: false, interrupt: false }, currentAssistantText: "Readable response" }, true);
  display.toggle(); assert.equal(opens, 0); assert.match(body, /original Codex window/);
  display.scroll(1); display.toggle(); assert.match(body, /^Readable response/); assert.equal(opens, 0);
});
