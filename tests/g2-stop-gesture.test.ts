import test from "node:test";
import assert from "node:assert/strict";
import { G2Display } from "../apps/evenhub/src/g2/display.js";
import { STOP_MENU_ID, nativeLayout } from "../apps/evenhub/src/g2/native.js";
import { initialState, type RuntimeState } from "../packages/cockpit-state/types.js";

const wait = () => new Promise(resolve => setTimeout(resolve, 150));
const state = (): RuntimeState => ({ ...initialState(), connected: true,
  session: { key: "current", name: "Current", cwd: "fixture" }, main: { status: "running" }, currentAssistantText: "Working feedback" });
test("only the terminal Terminate task menu interrupts; duplicate, offline, read-only and idle requests are guarded", async t => {
  const stopped: string[] = []; let exits = 0, body = "";
  let release!: () => void;
  const display = new G2Display((_, text) => { body = text; }, () => {}, undefined, {
    renderer: { pages: text => [text], render: () => [] }, interrupt: async key => {
      stopped.push(key); await new Promise<void>(resolve => { release = resolve; });
    },
  });
  t.after(() => display.dispose()); display.update(state(), true);
  await display.init({ onEvenHubEvent: () => () => {}, createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => true, textContainerUpgrade: async () => true, updateImageRawData: async () => "success",
    shutDownPageContainer: async () => { exits++; return true; } } as any);
  const stop = () => display.handleEvent({ menuItemClickEvent: { itemID: STOP_MENU_ID } } as any);
  const menu = nativeLayout({ body: "Working", layoutKey: "terminal:current" }).menuObject.menuItems!;
  assert.equal(menu[0].itemID, STOP_MENU_ID); assert.equal(menu[0].itemName, "Terminate task");
  assert.deepEqual(menu.map(item => item.itemName), ["Terminate task", "Sessions"]);
  const detail = nativeLayout({ body: "Earlier message", layoutKey: "message:current", detail: { previous: true, next: true } }).menuObject.menuItems!;
  assert.equal(detail[0].itemID, STOP_MENU_ID);
  for (const frame of [{ body: "Draft", layoutKey: "composer:current" }, { body: "Sessions", layoutKey: "sessions", picker: true }]) {
    assert.ok(!nativeLayout(frame).menuObject.menuItems!.some(item => item.itemID === STOP_MENU_ID));
  }
  display.handleEvent({ sysEvent: { eventType: 4 } } as any);
  stop(); assert.deepEqual(stopped, ["current"]); stop(); release();
  display.handleEvent({ sysEvent: { eventType: 5 } } as any); await wait();
  assert.deepEqual(stopped, ["current"]); assert.equal(exits, 0); assert.match(body, /Stop requested/);
  for (const [runtime, online, notice] of [
    [state(), false, /Disconnected/],
    [{ ...state(), capabilities: { interrupt: false } }, true, /Ctrl\+C/],
    [{ ...state(), main: { status: "idle" } }, true, /No running instruction/],
  ] as const) {
    display.update(runtime as RuntimeState, online); stop(); await wait();
    assert.match(body, notice); assert.equal(stopped.length, 1); assert.equal(exits, 0);
  }
  display.update(state(), true); display.setComposer({ text: "Draft", hint: "Editing" }); stop(); await wait();
  assert.equal(stopped.length, 1, "stale stop menu events cannot interrupt from the editor");
});

test("terminal double always confirms exit without interrupting, including running, idle and offline sessions", async t => {
  const modes: number[] = []; let stops = 0, body = "", opens = 0;
  const display = new G2Display((_, text) => { body = text; }, () => {}, undefined, {
    renderer: { pages: text => [text], render: () => [] }, interrupt: async () => { stops++; },
    input: { open: () => { opens++; }, toggleRecording: () => {} },
  });
  t.after(() => display.dispose());
  const idle = { ...state(), main: { status: "idle" as const } };
  display.update(idle, true);
  await display.init({ onEvenHubEvent: () => () => {}, createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => true, textContainerUpgrade: async () => true,
    shutDownPageContainer: async (mode: number) => { modes.push(mode); return true; } } as any);
  const double = () => display.handleEvent({ textEvent: { eventType: 3 } } as any);
  double(); double(); await wait();
  assert.deepEqual(modes, [1]); assert.equal(stops, 0); assert.match(body, /Double: exit/);
  display.handleEvent({ sysEvent: { eventType: 4 } } as any);
  display.handleEvent({ sysEvent: { eventType: 5 } } as any);
  display.handleEvent({ textEvent: { eventType: 0 } } as any); assert.equal(opens, 1);
  await wait(); display.update(idle, false); double(); await wait();
  assert.deepEqual(modes, [1, 1]); assert.match(body, /Double: exit/);
  display.update({ ...idle, subagents: { active: 2 } }, true); double(); await wait();
  assert.equal(stops, 0); assert.deepEqual(modes, [1, 1, 1]);
  display.update(state(), true); double(); await wait(); assert.deepEqual(modes, [1, 1, 1, 1]);
  assert.match(body, /Double: exit/); assert.doesNotMatch(body, /Double: stop/);
  display.handleEvent({ sysEvent: { eventType: 6 } } as any); double();
  assert.deepEqual(modes, [1, 1, 1, 1]); assert.equal(stops, 0);
});
