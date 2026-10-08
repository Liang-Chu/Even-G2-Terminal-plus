import { pageText } from "./helpers/g2-page.js";
import test from "node:test";
import assert from "node:assert/strict";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { SESSIONS_MENU_ID } from "../apps/evenhub/src/g2/native.js";
import { initialState, type RuntimeState } from "../packages/cockpit-state/types.js";
import { textPages, shortLine } from "../apps/evenhub/src/g2/text.js";
import { G2_LAYOUT, measuredPages, fitText } from "../apps/evenhub/src/g2/renderer.js";
import type { SessionSummary } from "../apps/evenhub/src/sessions/panel.js";

const session = (key: string, monitored = true, updatedAt = 1): SessionSummary => ({ key, id: key, name: key, cwd: "C:\\project", messageCount: 4, runtimeStatus: "idle", monitored, updatedAt });
const state = (key = "current", text = "Latest **reply**"): RuntimeState => ({ ...initialState("C:\\project"), connected: true,
  session: { key, id: key, name: key, cwd: "C:\\project" }, currentAssistantText: text });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("G2 keeps connected conversation status when another computer exhausts its retries", t => {
  let body = "";
  const display = new G2Display((_, value) => { body = value; }, () => {});
  t.after(() => display.dispose());
  display.update({ ...state(), source: { id: "local", name: "laptop", nameSource: "tailscale", online: true, connectionState: "online" },
    hosts: [{ id: "remote", name: "nuc", nameSource: "tailscale", online: false, connectionState: "offline", retryAttempt: 5 }] }, true);
  assert.match(body, /Latest reply/);
  assert.doesNotMatch(body, /offline|reconnecting/);
});

test("G2 changes an exhausted selected computer to static Offline and retains watched sessions", async t => {
  let body = "";
  const display = new G2Display((_, value) => { body = value; }, () => {}, { list: async () => [], open: async () => state() });
  t.after(() => display.dispose());
  const runtime: RuntimeState = { ...state(), connected: false,
    source: { id: "remote", name: "nuc", nameSource: "tailscale", online: false, connectionState: "retrying", retryAttempt: 5 },
    monitoring: { watched: 1, running: 0, since: 0, sessions: [{ key: "current", name: "Current", cwd: "/test", status: "offline", monitored: true, current: true }] } };
  display.update(runtime, false); assert.match(body, /reconnecting/);
  display.update({ ...runtime, source: { ...runtime.source!, connectionState: "offline" } }, false);
  assert.match(body, /offline · reconnect on phone/); assert.doesNotMatch(body, /reconnecting/);
  await display.openSessions(); assert.match(body, /Offline\. Reconnect in phone Connection/);
  assert.equal(runtime.monitoring!.sessions[0].monitored, true);
});

test("G2 hides offline watched sessions and restores them when reachable without changing Watch", async t => {
  let body = "", opened = "";
  const display = new G2Display((_, value) => { body = value; }, () => {}, {
    list: async () => [], open: async key => { opened = key; return state(key); },
  });
  t.after(() => display.dispose());
  const snapshot = (online: boolean): RuntimeState => ({ ...state(), monitoring: { watched: 3, running: 0, since: 0, sessions: [
    { key: "ready", name: "Ready session", cwd: "/test", status: "idle", monitored: true, current: true },
    { key: "closed", name: "Closed terminal", cwd: "/test", status: "offline", monitored: true, current: false },
    { key: "remote", name: "Remote session", cwd: "/test", status: "idle", monitored: true, current: false,
      source: { id: "remote-host", name: "NUC", nameSource: "tailscale", online } },
  ] } });
  const offline = snapshot(false);
  display.update(offline, true); await display.openSessions();
  assert.match(body, /Ready session/); assert.doesNotMatch(body, /Closed terminal|Remote session/);
  display.update(snapshot(true), true);
  assert.match(body, /Remote session/); assert.doesNotMatch(body, /Closed terminal/);
  display.update(snapshot(false), true); assert.doesNotMatch(body, /Remote session/);
  assert.equal(opened, ""); assert.ok(offline.monitoring!.sessions.every(row => row.monitored));
  await display.selectSession(); assert.equal(opened, "ready");
});

test("G2 restore and catalog picker skip a remembered offline session and disconnected host", async t => {
  let body = "", opened = "", remembered = "closed";
  const display = new G2Display((_, value) => { body = value; }, () => {}, {
    list: async () => [
      { ...session("closed", true, 99), runtimeStatus: "offline" },
      { ...session("remote", true, 88), source: { id: "host", name: "Offline device", nameSource: "hostname", online: false } },
      session("ready", true, 1),
    ],
    open: async key => { opened = key; return state(key); },
  }, { memory: { read: async () => remembered, write: key => { remembered = key; } } });
  t.after(() => display.dispose());
  display.update(state(), true); await tick();
  assert.equal(opened, "ready"); assert.equal(remembered, "ready");
  await display.openSessions(); assert.match(body, /ready/); assert.doesNotMatch(body, /closed|remote/);
});

test("G2 header and watched session picker identify the source computer", async t => {
  let header = "", body = "";
  const source = (name: string) => ({ id: name, name, nameSource: "tailscale" as const, online: true });
  const display = new G2Display((h, b) => { header = h; body = b; }, () => {}, {
    list: async () => [], open: async () => state(),
  });
  t.after(() => display.dispose());
  display.update({ ...state(), source: source("nuc"), monitoring: { running: 0, watched: 2, since: 0, sessions: [
    { key: "nuc-key", name: "Same title", cwd: "/project", status: "idle", monitored: true, current: true, source: source("nuc") },
    { key: "laptop-key", name: "Same title", cwd: "C:\\project", status: "idle", monitored: true, current: false, source: source("liam") },
  ] } }, true);
  assert.match(header, /^nuc · agents: 0 \|/);
  await display.openSessions();
  assert.match(body, /nuc · Same title/); assert.match(body, /liam · Same title/);
});

test("G2 enters conversation; swipes read, native menu shows watched sessions newest first, one tap switches while another runs", async t => {
  let header = "", body = "", mode = "", opened = "";
  const display = new G2Display((h, b, m) => { header = h; body = b; mode = m; }, () => {}, {
    list: async () => [session("older"), session("hidden", false, 99), session("recent", true, 2)],
    open: async key => { opened = key; return state(key); },
  });
  t.after(() => display.dispose()); display.update(state(), true);
  assert.equal(mode, "terminal"); assert.match(body, /Latest reply/); assert.doesNotMatch(body, /\*\*/);
  display.handleEvent({ textEvent: { eventType: 2 } } as any); assert.equal(mode, "terminal");
  display.handleEvent({ sysEvent: { eventType: 4 } } as any);
  display.handleEvent({ menuItemClickEvent: { itemID: SESSIONS_MENU_ID } } as any);
  display.handleEvent({ sysEvent: { eventType: 5 } } as any); await tick();
  assert.equal(mode, "sessions"); assert.match(body, /> recent/); assert.doesNotMatch(body, /hidden|New session/);
  assert.equal(header, "Sessions");
  display.update({ ...state(), main: { status: "running" } }, true);
  display.handleEvent({ sysEvent: { eventSource: 1 } } as any); await tick();
  assert.equal(opened, "recent"); assert.equal(mode, "terminal");
});

test("G2 handles offline errors, stale responses, removed watches and duplicate taps", async t => {
  let calls = 0, body = "", mode = "", fail = true;
  let finish!: () => void;
  const display = new G2Display((_, b, m) => { body = b; mode = m; }, () => {}, {
    list: async () => { if (fail) throw new Error("List unavailable"); return [session("saved")]; },
    open: async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); return state("saved"); },
  });
  t.after(() => display.dispose()); display.update(state(), false);
  await display.openSessions(); assert.match(body, /Reconnecting/);
  display.update(state(), true); await display.openSessions(); assert.match(body, /List unavailable/);
  await display.selectSession(); assert.equal(calls, 0);
  fail = false; await display.openSessions();
  const opening = display.selectSession(); await display.selectSession(); assert.equal(calls, 1);
  finish(); await opening; assert.equal(mode, "terminal");
  await display.openSessions();
  display.update({ ...state(), monitoring: { watched: 0, running: 0, since: Date.now(), sessions: [] } }, true);
  assert.match(body, /No available watched sessions/); await display.selectSession(); assert.equal(calls, 1);
  display.handleEvent({ sysEvent: { eventType: 3 } } as any); assert.equal(mode, "terminal");
});

test("G2 ignores a late list response after returning to conversation", async t => {
  let resolveList!: (sessions: SessionSummary[]) => void, mode = "";
  const display = new G2Display((_, __, m) => { mode = m; }, () => {}, {
    list: () => new Promise(resolve => { resolveList = resolve; }), open: async () => state(),
  });
  t.after(() => display.dispose()); display.update(state(), true);
  const loading = display.openSessions(); display.back(); resolveList([session("saved")]); await loading;
  assert.equal(mode, "terminal");
});

test("expanded message remains stable during streaming and returning to input refreshes the previews", t => {
  let body = "";
  const display = new G2Display((_, b) => { body = b; }, () => {}); t.after(() => display.dispose());
  const text = Array.from({ length: 21 }, (_, i) => `Line ${i + 1}`).join("\n");
  display.update(state("current", text), true); assert.match(body, /Line 1/); assert.match(body, /^> New prompt/);
  display.scroll(1); display.toggle(); const reading = body;
  assert.match(body, /Line 21/);
  display.update(state("current", text + "\nNew arrival"), true);
  assert.equal(body.split("\n\n")[0], reading.split("\n\n")[0]); assert.match(body, /\+new/);
  display.back();
  display.update(state("current", "New arrival\n" + text), true); assert.match(body, /New arrival/);
  const pages = textPages("中文😀".repeat(100)); assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.split("\n").length <= 6));
  assert.equal(shortLine("😀😀😀", 4), "😀…");
});

test("SDK layout keeps separate header and native Sessions menu; restores a watched session and forwards voice gestures", async t => {
  let layout: any, listener: any, opened = "", memory = "previous", presses = 0, releases = 0, pcm = 0, cancelled = 0;
  const bridge = {
    createStartUpPageContainer: async (value: any) => { layout = value; return 0; },
    onEvenHubEvent: (handler: any) => { listener = handler; return () => {}; },
    updateImageRawData: async () => "success",
    textContainerUpgrade: async () => true,
    rebuildPageContainer: async () => true,
  };
  const display = new G2Display(() => {}, () => {}, {
    list: async () => [session("previous", true, 1), session("latest", true, 2)],
    open: async key => { opened = key; return state(key); },
  }, { renderer: { pages: text => textPages(text), render: () => [] }, memory: { read: async () => memory, write: key => { memory = key; } },
    input: { open: () => presses++, toggleRecording: () => releases++, pause: () => cancelled++, cancel: () => cancelled++, audio: data => { pcm += data.length; } } });
  t.after(() => display.dispose()); display.update(state(), true); await display.init(bridge as any); await tick();
  assert.equal(opened, "previous"); assert.equal(layout.containerTotalNum, 6);
  assert.equal(layout.textObject.length, 1); assert.match(pageText(layout), /Latest reply/);
  const capture=layout.listObject[0];assert.equal(capture.containerID,8);assert.equal(capture.isEventCapture,1);
  assert.equal(capture.itemContainer.itemName[0],"New prompt");
  assert.equal(layout.imageObject.length, 4);
  assert.deepEqual(layout.imageObject.map((image: any) => [image.xPosition, image.yPosition, image.width, image.height]),
    [[0,0,288,34],[288,0,288,34],[0,262,288,26],[288,262,288,26]]);
  assert.equal(layout.menuObject.menuItems[1].itemName, "Sessions");
  listener({ textEvent: { eventType: 0 } });
  display.setComposer({ text: "Draft", phase: "review", hint: "Tap: record" });
  await new Promise(resolve => setTimeout(resolve, 120));
  listener({ textEvent: { eventType: 0 } }); listener({ audioEvent: { audioPcm: new Uint8Array(8) } });
  assert.equal(presses, 1); assert.equal(releases, 1); assert.equal(pcm, 8);
  listener({ sysEvent: { eventType: 4 } }); assert.ok(cancelled > 0);
});

test("compact G2 header counts the current main agent plus children, without counting other sessions or tools", t => {
  let header = "", body = "";
  const display = new G2Display((h, b) => { header = h; body = b; }, () => {}, undefined, { input: { open() {}, toggleRecording() {} } });
  t.after(() => display.dispose());
  const runtime = state("A long session title that should be truncated without animation");
  runtime.main = { status: "running", startedAt: Date.now() - 2000 };
  runtime.session.model = "deepseek/deepseek-v4-pro";
  runtime.monitoring = { running: 6, watched: 6, since: 0, sessions: [] };
  display.update(runtime, true);
  assert.equal(header, `agents: 1 | Pi · deepseek-v4-pro | ${runtime.session.name}`);
  assert.match(body, /Latest reply/); assert.match(body, /running 00:00/);
  assert.doesNotMatch(body, /\d+\/\d+/); assert.match(body, /Tap: open/);
  display.update({ ...runtime, subagents: { active: 3 } }, true); assert.match(header, /agents: 4/);
  display.update({ ...runtime, tools: { active: { child: { name: "subagent", startedAt: 0 } } } }, true); assert.match(header, /agents: 1\+/);
  display.update({ ...runtime, tools: { active: { read: { name: "read", startedAt: 0 }, shell: { name: "bash", startedAt: 0 } } } }, true); assert.match(header, /agents: 1 \|/);
  display.update({ ...runtime, main: { status: "idle" } }, true); assert.match(header, /^agents: 0 \|/);
  display.update({ ...runtime, main: { status: "idle" }, subagents: { active: 2 } }, true); assert.match(header, /^agents: 2 \|/);
  display.update({ ...runtime, main: { status: "waiting" } }, true); assert.match(header, /agents: 0/);
  display.update(runtime, false); assert.match(header, /agents: \?/); assert.match(body, /reconnecting/);
});

test("small canvas typography, measured CJK wrapping and static titles stay within the viewport", () => {
  assert.ok(G2_LAYOUT.small < G2_LAYOUT.body);
  const measure = (value: string) => Array.from(value).reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 22 : 12), 0);
  assert.equal(fitText("中文😀", measure, 60), "中...");
  assert.equal(fitText("liam", measure, 50), "liam");
  assert.equal(fitText("Long title", measure, 10), "");
  assert.ok(measure(fitText("Long title ".repeat(100), measure, 230)) <= 230);
  const pages = measuredPages("中文😀 and text ".repeat(50), measure);
  assert.ok(pages.length > 1);
  for (const page of pages) { assert.ok(page.split("\n").length <= 7); for (const line of page.split("\n")) assert.ok(measure(line) <= 560); }
  assert.ok(G2_LAYOUT.bodyY + G2_LAYOUT.rows * G2_LAYOUT.lineHeight + G2_LAYOUT.small < 270);
});

test("image transport serializes tiles, retries transient failures, and sends only changed tiles", { timeout: 12_000 }, async t => {
  let active = 0, maximum = 0, attempts = 0, fail = true, revision = 0;
  const sent: number[] = [], connection: string[] = [];
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 6000;
    while (!condition()) { assert.ok(Date.now() < deadline, "image transport timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  const bridge = {
    createStartUpPageContainer: async () => 0,
    onEvenHubEvent: () => () => {},
    textContainerUpgrade: async () => true,
    rebuildPageContainer: async () => true,
    updateImageRawData: async (value: any) => {
      attempts++; maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
      if (fail) { fail = false; return "failure"; }
      assert.ok(value.imageData instanceof Uint8Array);
      sent.push(value.containerID); return "success";
    },
  };
  const display = new G2Display(() => {}, text => connection.push(text), undefined, {
    renderer: { pages: text => [text], render: () => Array.from({ length: 4 }, (_, index) => ({
      id: index + 2, name: `tile-${index}`, png: `data:image/png;base64,${Buffer.from([137, 80, 78, 71, index, index === 2 ? revision : 0]).toString("base64")}`,
    })) },
  });
  t.after(() => display.dispose()); display.update(state(), true); await display.init(bridge as any);
  await waitFor(() => sent.length === 4);
  assert.equal(attempts, 5); assert.equal(maximum, 1); assert.deepEqual(sent, [2, 3, 4, 5]);
  assert.ok(connection.some(text => /G2 display retrying · image update rejected/.test(text))); assert.equal(connection.at(-1), "G2 connected");
  await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(attempts, 5);
  display.scroll(1); // Keep the list mounted while testing changed-tile transport.
  revision++; display.update(state("current", "Better reply"), true);
  await waitFor(() => sent.length === 5); assert.equal(sent.at(-1), 4);
  display.handleEvent({ sysEvent: { eventType: 4 } } as any); revision++;
  display.update({ ...state("current", "Newest reply"), main: { status: "running" } }, true);
  await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(sent.length, 5);
  display.handleEvent({ sysEvent: { eventType: 5 } } as any);
  await waitFor(() => sent.length === 6); assert.deepEqual(sent.slice(5), [4], "closing the menu sends only changed tiles");
});
