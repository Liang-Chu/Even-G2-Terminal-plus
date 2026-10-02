import {
  waitForEvenAppBridge, CreateStartUpPageContainer, RebuildPageContainer, TextContainerUpgrade,
  ImageRawDataUpdate,
  validateEvenHubPageContainer, formatEvenHubPageContainerValidationError,
  type EvenAppBridge, type EvenHubEvent, type DeviceStatus,
} from "@evenrealities/even_hub_sdk";
import type { RuntimeState } from "../../../../packages/cockpit-state/types.js";
import { elapsedTime, sessionHeader, sessionAgentCount } from "../../../../packages/cockpit-state/selectors.js";
import type { SessionSummary } from "../sessions/panel.js";
import { shortLine, textPages } from "./text.js";
import { glassesMessages } from "../../../../packages/cockpit-state/g2-reply.js";
import { CanvasG2Renderer, G2_READING_PADDING, pngBytes, type G2Renderer, type G2Tile } from "./renderer.js";
import { BACK_MENU_ID, SEND_MENU_ID, SESSIONS_MENU_ID, STOP_MENU_ID, PREVIOUS_PART_MENU_ID, NEXT_PART_MENU_ID, GESTURE_CONTAINER_ID, CONFIRM_CONTAINER_ID, nativeTexts, nativeBody, nativeLabel, nativeHeading, nativeLayout, nativeLayoutKey, type NativeFrame, type NativeListEntry } from "./native.js";
import { MessageBrowser, nativeTextPrefix } from "./messages.js";
import { TapGestures } from "./tap-gestures.js";
import { bridgeBatch, serialBridge } from "../bridge/serial.js";
import { glassesInteraction, type Interaction, type InteractionAnswer } from "../../../../packages/cockpit-state/interactions.js";

interface SessionControls {
  list: () => Promise<SessionSummary[]>;
  open: (key: string) => Promise<RuntimeState>;
}
export interface G2InputTrace {
  at: number;
  events: { source: string; type?: number; container?: number; index?: number }[];
  screen: string; before: number; after: number; paused: boolean; closed: boolean;
}
interface DisplayOptions {
  renderer?: G2Renderer;
  frame?: (canvas: HTMLCanvasElement) => void;
  memory?: { read: () => Promise<string | undefined>; write: (key: string) => void };
  ready?: (bridge: EvenAppBridge) => void;
  viewed?: (key: string | undefined) => void;
  inputTrace?: (trace: G2InputTrace) => void;
  interrupt?: (key: string) => Promise<void>;
  respond?: (key: string, answer: InteractionAnswer) => Promise<void>;
  input?: { open: () => void; toggleRecording: () => void; hasDraft?: () => boolean; send?: () => void; finish?: () => void; startDeleting?: () => void;
    stopDeleting?: () => void; pause?: () => void; cancel?: () => void; audio?: (pcm: Uint8Array) => void };
}
interface Composer { text: string; hint: string; phase?: string }
class DisplayError extends Error {
  constructor(message: string, readonly canProbe = false) { super(message); }
}
const MESSAGE_REFRESH_MS = 2000;

/** One conversation surface, plus a watched-only picker reached through the OS menu. */
export class G2Display {
  private bridge?: EvenAppBridge;
  private state?: RuntimeState;
  private conversationState?: RuntimeState;
  private messageRefreshAt = 0;
  private messageNavigationAt = 0;
  private browsingMessages = false;
  private messages: MessageBrowser;
  private wrapped = new Map<string, string[]>();
  private online = false;
  private mode: "terminal" | "sessions" = "terminal";
  private sessions: SessionSummary[] = [];
  private sessionCatalog: SessionSummary[] = [];
  private selection = 0;
  private sessionLoading = false;
  private sessionSwitching = false;
  private sessionError = "";
  private sessionRequest = 0;
  private composer?: Composer;
  private draftConfirmation?: { selected: number };
  private composerLine = 0;
  private sessionPage = 0;
  private nativeFrame?: NativeFrame;
  private nativeSelection = 0;
  private compatibilityReason = "";
  private compactLabels = false;
  private lastNativeTexts = new Map<number, string>();
  private lastNativeHeading = "";
  private lastPreview = "";
  private lastRendered = "";
  private renderedTiles: G2Tile[] = [];
  private rebuilding = false;
  private diagnosing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = 0;
  private lastFlushAt = 0;
  private interactivePending = false;
  private last: string[] = [];
  private clock: ReturnType<typeof setInterval>;
  private busy = false;
  private dirty = false;
  private paused = false;
  private unsubscribe?: () => void;
  private unsubscribeDevice?: () => void;
  private deviceSn = "";
  private deviceConnected?: boolean;
  private pageCreated = false;
  private displayEpoch = 0;
  private disposed = false;
  private restored = false;
  private restoring = false;
  private storageScope = "default";
  private remembered = "";
  private renderer?: G2Renderer;
  private retryAt = 0;
  private failures = 0;
  private stopping = new Set<string>();
  private exitRequest = false;
  private stopNotice?: { key: string; text: string; until: number };
  private choiceId = "";
  private choiceIndex = 0;
  private choiceHidden = false;
  private choiceSending = false;
  private choiceNotice = "";
  private taps = new TapGestures({
    single: () => this.toggle(),
    double: () => {
      if (this.draftConfirmation) this.back();
      else if (this.composer) this.confirmDraftExit();
      else if (this.nativeFrame?.confirmation || this.nativeFrame?.layoutKey.startsWith("composer:") || this.choice() || this.messages.detail || this.nativeFrame?.layoutKey.startsWith("message:") || this.mode === "sessions") this.back();
      else void this.confirmExit();
    },
  });
  constructor(
    private preview: (header: string, body: string, mode: string) => void,
    private connection: (text: string) => void,
    private sessionControls?: SessionControls,
    private options: DisplayOptions = {},
  ) {
    this.renderer = options.renderer || (typeof document === "undefined" ? undefined : new CanvasG2Renderer());
    this.messages = new MessageBrowser();
    this.clock = setInterval(() => {
      if (this.failures || this.mode === "terminal" && (this.composer?.phase === "recording" || !this.composer && !this.messages.detail)) this.schedule(false);
    }, 500);
  }

  async init(suppliedBridge?: EvenAppBridge) {
    const bridge = serialBridge(suppliedBridge || await waitForEvenAppBridge());
    if (this.disposed) return;
    if (!suppliedBridge && typeof window !== "undefined" && !(window as Window & { flutter_inappwebview?: { callHandler?: unknown } }).flutter_inappwebview?.callHandler)
      throw new Error("Open in Even Hub to connect G2");
    if (this.bridge) { this.resync(); return; }
    if (!this.renderer) throw new Error("G2 renderer is unavailable");
    this.bridge = bridge;
    this.unsubscribe = bridge.onEvenHubEvent(event => this.handleEvent(event));
    this.busy = true;
    try {
      const parts = this.parts(), frame = this.makeNativeFrame(parts);
      this.renderPreview(frame, parts);
      await this.mountNativeFrame(frame, this.displayEpoch);
    }
    catch (error) { this.displayFailed(error); }
    finally { this.busy = false; }
    // Attempt startup before storage/device requests. Even when it fails, let
    // the phone restore its connection and speech settings through the same queue.
    if (this.disposed) return;
    this.unsubscribeDevice = bridge.onDeviceStatusChanged?.(status => { void this.observeDevice(status).catch(() => {}); });
    this.options.ready?.(bridge);
    void this.observeDevice().catch(() => {});
    this.schedule(); void this.restoreSession();
  }
  private async mountNativeFrame(frame: NativeFrame, epoch: number) {
    this.rebuilding = true;
    const send = async (layout = nativeLayout(frame)) => {
      if (this.disposed || !this.bridge) throw new Error("Display closed");
      const validation = validateEvenHubPageContainer(layout);
      if (!validation.valid) throw new DisplayError(`SDK layout: ${formatEvenHubPageContainerValidationError(validation)}`);
      if (this.pageCreated) {
        if (!await this.bridge!.rebuildPageContainer(new RebuildPageContainer(layout)))
          throw new DisplayError("rebuild rejected", true);
      } else {
        const result = await this.bridge!.createStartUpPageContainer(new CreateStartUpPageContainer(layout));
        if (result !== 0) throw new DisplayError(`create: ${["success", "invalid", "oversize", "out of memory"][result] || "rejected"} (${result})`, result === 1);
        this.pageCreated = true;
      }
    };
    const sendWithLabelRetry = async () => {
      try { await send(); }
      catch (error) {
        if (!(error instanceof DisplayError) || !frame.conversationList || this.compactLabels ||
          !frame.entries?.some(entry => new TextEncoder().encode(entry.label).length > 63)) throw error;
        // Retain a shorter-label policy only when that isolated change succeeds.
        // A rejected rich page does not prove that a native text/list page also
        // needs shorter labels; otherwise basic view wastes most of a CJK row.
        this.diagnosing = true; this.compactLabels = true; frame = this.makeNativeFrame();
        try { await send(); }
        catch (retryError) { this.compactLabels = false; frame = this.makeNativeFrame(); throw retryError; }
      }
    };
    try {
      try { await sendWithLabelRetry(); }
      catch (error) {
        // Explicit page rejections fall back to normal native containers.
        // Transport exceptions retain normal backoff instead.
        if (!(error instanceof DisplayError) || frame.picker || this.compatibilityReason) throw error;
        this.diagnosing = true;
        this.compatibilityReason = error.message;
        if (error.canProbe) {
          // One image-free comparison, then restore the readable basic view.
          // A transport failure stops probing and retains normal retry backoff.
          const layout = nativeLayout(frame), images = "imageObject" in layout ? layout.imageObject?.length || 0 : 0;
          if (images) try {
            await send({ ...layout, imageObject: [], containerTotalNum: layout.containerTotalNum - images });
            this.compatibilityReason += "; no-images: OK";
          } catch (probeError) {
            if (!(probeError instanceof DisplayError)) throw probeError;
            this.compatibilityReason += `; no-images: ${probeError.message}`;
          }
        }
        if (frame.conversationList) this.messages.selectInput();
        frame = this.makeNativeFrame();
        await sendWithLabelRetry();
      }
    }
    finally { this.rebuilding = false; this.diagnosing = false; }
    if (this.disposed) return frame;
    if (this.deviceConnected !== false) this.connectedNotice();
    if (epoch === this.displayEpoch) {
      this.nativeFrame = frame; this.nativeSelection = 0; this.last = [];
      this.lastNativeTexts.clear();
      for (const text of nativeTexts(frame)) this.lastNativeTexts.set(text.id,
        JSON.stringify([nativeTextPrefix(text.content), text.color]));
      if (frame.picker && frame.conversationList) this.lastNativeTexts.set(7, frame.footer || "");
      this.lastNativeHeading = frame.heading || "";
    }
    if (frame.confirmation && this.draftConfirmation) this.draftConfirmation.selected = 0;
    if (frame.entries && !frame.conversationList && !frame.confirmation) this.selection = this.sessions.findIndex(session => session.key === frame.entries![0].key);
    return frame;
  }
  private connectedNotice() { this.connection(this.compatibilityReason ? `G2 connected · basic view${this.compactLabels ? " · compact labels" : ""} (${this.compatibilityReason})`
    : this.compactLabels ? "G2 connected · compact labels (long labels rejected)" : "G2 connected"); }
  private displayFailed(error?: unknown) {
    if (this.disposed) return;
    this.retryAt = Date.now() + Math.min(15_000, 1000 * 2 ** Math.min(++this.failures, 4));
    this.connection(`G2 display retrying · ${error instanceof DisplayError ? error.message : "bridge request failed"}`);
    this.reportViewed();
  }
  private async observeDevice(status?: DeviceStatus) {
    if (!this.bridge || this.disposed) return;
    if (!this.deviceSn) {
      const info = await this.bridge.getDeviceInfo?.();
      if (this.disposed || info?.model !== "g2") return;
      this.deviceSn = info.sn;
      status = status?.sn === info.sn ? status : info.status;
    }
    if (!status || status.sn !== this.deviceSn || status.connectType === "none") return;
    const connected = status.connectType === "connected", previous = this.deviceConnected;
    this.deviceConnected = connected;
    if (!connected) { this.options.input?.cancel?.(); this.connection("G2 disconnected · phone bridge is separate"); this.reportViewed(); }
    else if (previous === false) this.resync(true);
  }
  /** Re-send the latest snapshot after a bridge/BLE/foreground recovery. */
  resync(rebuild = false) {
    if (this.disposed) return;
    this.displayEpoch++; this.last = []; this.lastNativeTexts.clear(); this.lastNativeHeading = "";
    if (rebuild) this.nativeFrame = undefined;
    this.retryAt = 0; this.schedule();
  }
  setStorageScope(scope: string) {
    if (scope === this.storageScope) return;
    this.storageScope = scope; this.restored = false; this.remembered = ""; this.sessionCatalog = []; this.sessionRequest++;
  }
  private availableSessions(catalog: SessionSummary[]): SessionSummary[] {
    const known = new Map(catalog.map(session => [session.key, session]));
    const sessions: SessionSummary[] = this.state?.monitoring ? this.state.monitoring.sessions.map(session => ({
      ...known.get(session.key), key: session.key, id: session.key, name: session.name, cwd: session.cwd,
      source: session.source, monitored: session.monitored, runtimeStatus: session.status,
      updatedAt: session.updatedAt || known.get(session.key)?.updatedAt,
    })) : catalog;
    return sessions.filter(session => session.monitored && session.runtimeStatus !== "offline" && session.source?.online !== false);
  }
  private async restoreSession() {
    if (!this.online || !this.sessionControls || this.mode !== "terminal" || this.sessionSwitching || this.restored || this.restoring || this.disposed || (!this.bridge && !this.options.memory)) return;
    this.restoring = true;
    const request = ++this.sessionRequest;
    try {
      const remembered = await (this.options.memory?.read() || this.bridge!.getLocalStorage(`pilot.last-session.${this.storageScope}`)).catch(() => "");
      const catalog = await this.sessionControls.list();
      if (request !== this.sessionRequest || this.disposed) return;
      this.sessionCatalog = catalog;
      const sessions = this.availableSessions(catalog).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const target = sessions.find(session => session.key === remembered) || sessions.find(session => session.key === this.state?.session.key) || sessions[0];
      if (target && (target.key !== this.state?.session.key || !this.state?.connected)) {
        const state = await this.sessionControls.open(target.key);
        if (request !== this.sessionRequest || this.disposed) return;
        this.state = state; this.resetReading();
      }
      this.sessionError = ""; this.restored = true;
      if (target) this.remember(target.key);
    } catch { this.sessionError = "Could not restore session. Use Sessions."; }
    finally { this.restoring = false; this.schedule(); }
  }
  private remember(key: string) {
    if (key === this.remembered) return;
    this.remembered = key;
    if (this.options.memory) this.options.memory.write(key);
    else void this.bridge?.setLocalStorage(`pilot.last-session.${this.storageScope}`, key).catch(() => {});
  }
  update(state: RuntimeState, online: boolean) {
    const previous = this.state;
    const urgent = online !== this.online || state.session.key !== previous?.session.key || state.connected !== previous?.connected ||
      state.main.status !== previous?.main.status || !previous || sessionAgentCount(state, online) !== sessionAgentCount(previous, this.online) ||
      state.source?.online !== previous?.source?.online || state.interactions?.[0]?.id !== previous?.interactions?.[0]?.id;
    const changed = state.session.key !== this.state?.session.key;
    if (changed) { this.taps.reset(); this.stopNotice = undefined; this.resetReading(); this.composer = undefined; this.draftConfirmation = undefined; this.options.input?.cancel?.(); }
    this.state = state; this.online = online;
    const choiceId = (state.session.key || "") + ":" + (state.interactions?.[0]?.id || "");
    if (choiceId !== this.choiceId) {
      this.choiceId = choiceId;
      this.choiceIndex = 0; this.choiceHidden = false; this.choiceSending = false; this.choiceNotice = "";
    }
    if (!online) this.options.input?.cancel?.();
    // A backend reconnect does not erase the glasses' native page or PNGs.
    // Only actual BLE/foreground recovery invalidates acknowledged content.
    if (this.mode === "sessions" && state.monitoring) {
      const selected = this.sessions[this.selection]?.key;
      const available = this.availableSessions(this.sessionCatalog);
      const order = new Map(this.sessions.map((session, index) => [session.key, index]));
      this.sessions = available.sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity) || (b.updatedAt || 0) - (a.updatedAt || 0));
      this.selection = Math.max(0, this.sessions.findIndex(session => session.key === selected));
    }
    if (this.restored && state.session.key && (!state.monitoring || state.monitoring.sessions.some(s => s.key === state.session.key && s.monitored))) this.remember(state.session.key);
    this.schedule(urgent);
    if (online) void this.restoreSession();
  }
  setComposer(composer?: Composer) {
    if (!composer) this.draftConfirmation = undefined;
    if (this.composer && !composer) this.resetReading();
    if (composer?.text !== this.composer?.text) this.composerLine = Math.max(0, this.lines(composer?.text || "").length - 7);
    this.composer = composer; this.schedule();
  }
  private resetReading() {
    this.messages.reset();
    this.browsingMessages = false; this.messageNavigationAt = 0; this.messageRefreshAt = Date.now();
  }
  toggle() {
    if (this.draftConfirmation) { this.leaveDraft(); return; }
    // Ignore a late tap from the confirmation page while its replacement mounts.
    if (this.nativeFrame?.confirmation) return;
    if (this.mode === "sessions") {
      if (this.bridge && this.nativeFrame?.entries && !this.sessionError) void this.activateNativeEntry(this.nativeFrame.entries[this.nativeSelection]);
      else void this.selectSession();
      return;
    }
    if (this.choice()) { void this.answerChoice(); return; }
    if (this.composer) { this.options.input?.toggleRecording(); return; }
    if (this.messages.detail) return;
    if (this.messages.inputSelected) this.openInput();
    else { this.messages.open(); this.schedule(); }
  }
  private openInput() {
    if (this.choiceHidden && this.state?.interactions?.length) { this.messages.selectInput(); this.choiceHidden = false; this.schedule(); return; }
    if (this.state?.capabilities?.prompt === false) {
      this.stopNotice = { key: this.state.session.key!, text: "Continue in the original terminal.", until: Date.now() + 5000 }; this.schedule(); return;
    }
    this.messages.selectInput(); this.options.input?.open();
  }
  private confirmDraftExit() {
    if (!this.composer || this.draftConfirmation) return;
    if (!(this.options.input?.hasDraft?.() ?? !!this.composer.text.trim())) {
      this.options.input?.cancel?.(); this.setComposer(); return;
    }
    this.draftConfirmation = { selected: 0 };
    this.options.input?.stopDeleting?.(); this.options.input?.pause?.();
    this.schedule();
  }
  private leaveDraft() {
    if (!this.draftConfirmation || !this.composer || this.rebuilding ||
      this.bridge && !this.nativeFrame?.confirmation) return;
    const send = this.draftConfirmation.selected === 0;
    this.draftConfirmation = undefined;
    if (send && this.options.input?.finish) this.options.input.finish();
    else { this.options.input?.cancel?.(); this.setComposer(); }
    this.schedule();
  }
  handleEvent(event: EvenHubEvent) {
    const before = this.messages.selected;
    try { this.routeEvent(event); }
    finally {
      // Metadata only: never retain microphone bytes, messages, names or keys.
      if (this.options.inputTrace && !event.audioEvent) {
        const events: G2InputTrace["events"] = [];
        if (event.textEvent) events.push({ source: "text", type: event.textEvent.eventType ?? 0, container: event.textEvent.containerID });
        if (event.listEvent) events.push({ source: "list", type: event.listEvent.eventType ?? 0,
          container: event.listEvent.containerID, index: event.listEvent.currentSelectItemIndex });
        if (event.sysEvent) events.push({ source: "system", type: event.sysEvent.eventType ?? 0 });
        if (event.menuItemClickEvent) events.push({ source: "menu", index: event.menuItemClickEvent.itemID });
        if (events.length) this.options.inputTrace({ at: Date.now(), events,
          screen: this.draftConfirmation ? "confirm-send" : this.composer ? "editor" : this.messages.detail ? "message" : this.mode,
          before, after: this.messages.selected, paused: this.paused, closed: this.disposed });
      }
    }
  }
  private routeEvent(event: EvenHubEvent) {
    if (this.disposed) return;
    if (event.audioEvent) { this.options.input?.audio?.(event.audioEvent.audioPcm); return; }
    if (this.diagnosing && ![4, 5, 6, 7].includes(event.sysEvent?.eventType ?? -1)) return;
    if (this.draftConfirmation && event.menuItemClickEvent && event.menuItemClickEvent.itemID !== BACK_MENU_ID) return;
    if (event.menuItemClickEvent?.itemID === BACK_MENU_ID) {
      if (this.composer || this.messages.detail) this.back();
      return;
    }
    if (event.menuItemClickEvent?.itemID === SESSIONS_MENU_ID) { void this.openSessions(); return; }
    if (event.menuItemClickEvent?.itemID === SEND_MENU_ID) {
      if (this.composer?.phase === "review") this.options.input?.send?.();
      return;
    }
    if (event.menuItemClickEvent?.itemID === STOP_MENU_ID) { void this.stopCurrentRun(); return; }
    if ([PREVIOUS_PART_MENU_ID, NEXT_PART_MENU_ID].includes(event.menuItemClickEvent?.itemID || 0)) {
      this.messages.part(event.menuItemClickEvent!.itemID === NEXT_PART_MENU_ID ? 1 : -1); this.schedule(); return;
    }
    const system = event.sysEvent?.eventType;
    // The OS menu is the foreground overlay: 4 opens it, 5 dismisses it.
    // Neither event means the Hub app has exited (official contextual-menu contract).
    if (system === 4) { this.taps.reset(); this.paused = true; this.options.input?.pause?.(); return; }
    if (system === 5) { this.paused = false; this.schedule(); return; }
    if (system === 6 || system === 7) { this.dispose(); return; }
    if (this.paused || this.disposed) return;
    if (this.draftConfirmation) {
      if (this.rebuilding || this.bridge && !this.nativeFrame?.confirmation) return;
      const list = event.listEvent;
      if (list && (list.containerID === undefined || list.containerID === CONFIRM_CONTAINER_ID)) {
        const type = list.eventType ?? 0, index = list.currentSelectItemIndex ?? 0;
        if (index === 0 || index === 1) this.draftConfirmation.selected = index;
        else return;
        if (type === 0 || type === 3) this.taps.input(type);
        else this.schedule();
      } else if ((event.textEvent?.eventType ?? system) === 3) this.taps.input(3);
      return;
    }
    if (event.listEvent?.containerID === CONFIRM_CONTAINER_ID) return;
    const overview = this.mode === "terminal" && !this.composer && !this.choice() && !this.messages.detail;
    if (overview && event.listEvent) {
      if (this.rebuilding) return;
      const list = event.listEvent, type = list.eventType ?? 0;
      if (list.containerID !== undefined && list.containerID !== GESTURE_CONTAINER_ID) return;
      // Protobuf omits zero-valued fields, including the first item's index.
      const index = list.currentSelectItemIndex ?? 0;
      if (this.nativeFrame?.conversationList) {
        if (type === 3) { this.taps.input(type); return; }
        const entry = this.nativeFrame.entries?.[index];
        if (!entry) return;
        const target = entry?.key === "input" ? 0 : this.messages.messages.findIndex(message => message.id === entry?.key) + 1;
        if (entry.key !== "input" && target <= 0) return;
        this.scroll(target - this.messages.selected);
        if (type === 0) this.taps.input(type);
        return;
      }
      // Ignore unrelated or stale list events.
      return;
    }
    // The list's firmware selection is authoritative. Never increment it again
    // or rebuild its rows after a scroll: that resets focus and causes bouncing.
    if (event.listEvent && this.mode === "sessions") {
      if (this.rebuilding) return;
      const list = event.listEvent, type = list.eventType ?? 0;
      const index = list.currentSelectItemIndex ?? (type === 0 ? 0 : this.nativeSelection);
      const entry = this.nativeFrame?.entries?.[index];
      if (entry) this.nativeSelection = index;
      if (entry?.key) {
        const selection = this.sessions.findIndex(session => session.key === entry.key);
        if (selection >= 0) this.selection = selection;
      }
      if (type === 0 || type === 3) this.taps.input(type);
      else if (type === 1 || type === 2) this.schedule();
      return;
    }
    const text = event.textEvent || event.listEvent;
    // PB may omit the zero-valued CLICK enum, including a system touch event.
    const type = text ? text.eventType ?? 0 : event.sysEvent ? system ?? 0 : undefined;
    if (event.textEvent && this.mode === "sessions" && this.bridge && this.nativeFrame?.entries) return;
    if (type === 0 || type === 3) this.taps.input(type);
    else if (type === 1 || type === 2) {
      // Expanded messages belong to the native scroller. Never replace text
      // or rebuild the page in response to a native scroll/boundary event.
      if (this.messages.detail) return;
      if (overview && this.nativeFrame?.conversationList) {
        // Some firmware reports only a scroll/boundary event, without its row.
        // Keep the mounted list until a known input-row selection or return.
        this.browsingMessages = true; this.messageNavigationAt = Date.now(); return;
      }
      this.scroll(type === 1 ? -1 : 1);
    }
    else if (type === 9 && this.composer) this.options.input?.startDeleting?.();
    else if (type === 10) this.options.input?.stopDeleting?.();
  }
  scroll(direction: number) {
    if (this.draftConfirmation) {
      this.draftConfirmation.selected = Math.max(0, Math.min(1, this.draftConfirmation.selected + direction));
      this.schedule(); return;
    }
    const choice = this.choice();
    if (choice) {
      this.choiceIndex = Math.max(0, Math.min(choice.questions[0].options.length - 1, this.choiceIndex + direction));
      this.schedule(); return;
    }
    if (this.composer) {
      this.composerLine = Math.max(0, Math.min(this.lines(this.composer.text).length - 7, this.composerLine + direction));
      this.schedule(); return;
    }
    if (this.mode === "sessions") {
      if (this.sessionLoading || this.sessionSwitching) return;
      this.selection = Math.max(0, Math.min(this.sessions.length - 1, this.selection + direction)); this.sessionError = "";
    } else {
      this.messages.scroll(direction);
      this.browsingMessages = !this.messages.inputSelected; this.messageNavigationAt = Date.now();
    }
    this.schedule();
  }
  back() {
    if (this.draftConfirmation) { this.draftConfirmation = undefined; this.schedule(); return; }
    if (this.choice()) { this.hideChoice(); return; }
    if (this.sessionSwitching) return;
    if (this.messages.detail) {
      this.messages.back();
      // A recreated native list starts at its first row; keep app selection aligned.
      this.resetReading();
      this.schedule(); return;
    }
    if (this.composer) { this.options.input?.cancel?.(); this.setComposer(); }
    this.resetReading();
    this.sessionRequest++; this.sessionLoading = false; this.sessionError = ""; this.mode = "terminal"; this.schedule();
  }
  async openSessions() {
    if (this.sessionSwitching || this.sessionLoading || this.disposed) return;
    this.options.input?.cancel?.(); this.composer = undefined; this.draftConfirmation = undefined; this.messages.back();
    this.mode = "sessions"; this.sessionError = ""; this.sessionLoading = true; this.sessionPage = 0;
    const request = ++this.sessionRequest; this.schedule();
    try {
      if (!this.online || !this.sessionControls) throw new Error("Reconnecting. Try again when online.");
      // The bridge stream already contains every watched session. Avoid a
      // round trip that scans all saved Pi history on every menu visit.
      const catalog = this.state?.monitoring ? this.sessionCatalog : await this.sessionControls.list();
      if (request !== this.sessionRequest || this.disposed) return;
      this.sessionCatalog = catalog;
      this.sessions = this.availableSessions(catalog).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.key.localeCompare(b.key));
      this.selection = 0;
    } catch (error) { if (request === this.sessionRequest) this.sessionError = error instanceof Error ? error.message : "Could not load sessions."; }
    finally { if (request === this.sessionRequest) { this.sessionLoading = false; this.schedule(); } }
  }
  async selectSession() {
    if (this.mode !== "sessions" || this.sessionLoading || this.sessionSwitching || this.disposed) return;
    if (this.sessionError) { await this.openSessions(); return; }
    const session = this.sessions[this.selection];
    if (!session) return;
    if (!this.online || !this.sessionControls) { this.sessionError = "Reconnecting. Try again when online."; this.schedule(); return; }
    this.sessionSwitching = true; this.sessionError = ""; this.schedule();
    try {
      const state = await this.sessionControls.open(session.key);
      if (!this.disposed) {
        this.state = state; this.mode = "terminal"; this.resetReading();
        this.restored = true; this.remember(session.key);
      }
    } catch (error) { this.sessionError = error instanceof Error ? error.message : "Could not open session."; }
    finally { this.sessionSwitching = false; this.schedule(); }
  }
  private syncMessages() {
    if (!this.state || this.conversationState === this.state) return;
    const previous = this.conversationState, state = this.state;
    const unchanged = previous && previous.session.key === state.session.key && previous.main.status === state.main.status
      && previous.assistantOpen === state.assistantOpen && previous.currentAssistantText === state.currentAssistantText
      && previous.transcript.length === state.transcript.length && previous.transcript.every((entry, index) =>
        entry.id === state.transcript[index].id && entry.at === state.transcript[index].at && entry.role === state.transcript[index].role && entry.text === state.transcript[index].text);
    if (!unchanged) {
      const history = glassesMessages(state);
      this.messages.update({ ...history, messages: history.messages.slice().reverse() });
    }
    this.conversationState = state;
  }
  private refreshMessages() {
    const now = Date.now();
    if (this.busy || this.paused || this.mode !== "terminal" || this.composer || this.choice() || this.browsingMessages ||
      now - Math.max(this.messageRefreshAt, this.messageNavigationAt) < MESSAGE_REFRESH_MS) return;
    if (this.messages.refresh()) this.messageRefreshAt = now;
  }
  private messageRows(compact = this.compactLabels) {
    return this.messages.rows(this.state?.capabilities?.prompt !== false,
      this.choiceHidden && this.state?.interactions?.length ? "Review pending choice" : undefined, compact);
  }
  private choice() {
    return this.mode === "terminal" && !this.composer && !this.messages.detail && !this.choiceHidden ? this.state?.interactions?.[0] : undefined;
  }
  private choiceBody(request: Interaction, index: number) {
    const q = request.questions[0], option = q.options[index];
    return [q.text, request.detail, option ? `▶ ${index + 1}/${q.options.length} ${option.label}` : "",
      option?.description].filter(Boolean).join("\n");
  }
  private canAnswerChoice(request: Interaction) {
    return glassesInteraction(request) && request.questions[0].options.every((_, i) => this.lines(this.choiceBody(request, i)).length <= 7);
  }
  private hideChoice() { this.choiceHidden = true; this.resetReading(); this.schedule(); }
  private async answerChoice() {
    const choice = this.choice(), key = this.state?.session.key;
    if (!choice || !key || !this.options.respond || this.choiceSending) return;
    if (!this.online || !this.state?.connected) { this.choiceNotice = "Reconnecting. Answer not sent."; this.schedule(); return; }
    if (!this.canAnswerChoice(choice)) { this.choiceNotice = "Review and answer on phone."; this.schedule(); return; }
    if (choice.expiresAt <= Date.now()) { this.choiceNotice = "Choice expired. Refresh on phone."; this.schedule(); return; }
    const question = choice.questions[0], option = question.options[this.choiceIndex];
    if (!option) return;
    const identity = this.choiceId;
    this.choiceSending = true; this.choiceNotice = "Submitting…"; this.schedule();
    try {
      await this.options.respond(key, { requestId: choice.id, answers: { [question.id]: option.id } });
      if (this.choiceId === identity) this.choiceNotice = "Response submitted.";
    } catch { if (this.choiceId === identity) this.choiceNotice = "Unconfirmed. Check phone/Terminal."; }
    this.schedule();
  }
  private header() {
    const count = this.state ? sessionAgentCount(this.state, this.online) : "?";
    return `${this.state?.source ? shortLine(this.state.source.name, 20) + " · " : ""}agents: ${count} |`;
  }
  private status() {
    if (!this.online || !this.state || this.state.source?.online === false) return "reconnecting";
    if (!this.state.connected) return "terminal offline";
    const status = this.state.main.status;
    const since = ["running", "waiting"].includes(this.state.main.status) ? this.state.main.startedAt : this.state.main.statusSince ?? this.state.main.settledAt;
    const now = since === undefined ? Date.now() : since + Math.floor(Math.max(0, Date.now() - since) / 5000) * 5000;
    return `${status} ${elapsedTime(since, now)}`;
  }
  private statusLabel() {
    const notice = this.stopNotice;
    if (notice && notice.key === this.state?.session.key && notice.until > Date.now()) return notice.text;
    if (!this.online || !this.state || this.state.source?.online === false) return "reconnecting";
    return this.state.connected ? this.state.main.status : "terminal offline";
  }
  private async stopCurrentRun() {
    const state = this.state, key = state?.session.key;
    if (!key || this.disposed || this.composer || this.mode !== "terminal" || this.stopping.has(key) ||
      this.rebuilding || this.nativeFrame?.confirmation || this.nativeFrame?.sessionKey !== key) return;
    const show = (text: string) => {
      if (this.disposed || this.state?.session.key !== key) return;
      this.stopNotice = { key, text, until: Date.now() + 5000 }; this.resetReading(); this.schedule();
    };
    if (!this.online || !state.connected) { show("Disconnected. Stop in Terminal."); return; }
    if (!this.options.interrupt || state.capabilities?.interrupt === false) { show("Use Ctrl+C in this terminal to stop."); return; }
    if (!["running", "waiting"].includes(state.main.status) && !((state.subagents?.active ?? 0) > 0)) { show("No running instruction."); return; }
    this.stopping.add(key); show("Stopping…");
    try { await this.options.interrupt(key); show("Stop requested."); }
    catch { show("Stop unconfirmed. Check Terminal."); }
    finally { this.stopping.delete(key); }
  }
  private async confirmExit() {
    if (!this.bridge || this.disposed || this.exitRequest) return;
    const key = this.state?.session.key;
    this.exitRequest = true;
    try {
      // Mode 1 asks the OS to confirm. Only its exit event disposes the display;
      // cancelling the confirmation leaves this session and Watch untouched.
      if (!await this.bridge.shutDownPageContainer(1)) throw new Error("Exit unavailable");
    } catch {
      if (!this.disposed && key && this.state?.session.key === key) {
        this.stopNotice = { key, text: "Open menu to exit.", until: Date.now() + 5000 }; this.schedule();
      }
    } finally { this.exitRequest = false; }
  }
  private pages(text: string) { return this.renderer?.pages(text) || textPages(text, 46, 7); }
  private lines(text: string) {
    const cached = this.wrapped.get(text);
    if (cached) return cached;
    const lines = this.pages(text).flatMap(page => page.split("\n"));
    if (this.wrapped.size >= 4) this.wrapped.delete(this.wrapped.keys().next().value!);
    this.wrapped.set(text, lines); return lines;
  }
  private async activateNativeEntry(entry?: NativeListEntry) {
    if (this.sessionLoading || this.sessionSwitching || this.disposed) return;
    if (entry?.page !== undefined) {
      this.sessionPage = entry.page; this.selection = entry.page * 18; this.schedule();
    } else if (entry?.key) {
      const selection = this.sessions.findIndex(session => session.key === entry.key);
      if (selection < 0) { this.sessionError = "Session is unavailable or no longer watched."; this.schedule(); return; }
      this.selection = selection; await this.selectSession();
    }
  }
  private makeNativeFrame(parts = this.parts()): NativeFrame {
    const frame = { ...this.makeFullNativeFrame(parts), footer: parts[4] };
    if (!this.compatibilityReason || frame.picker) return frame;
    const heading = nativeHeading(parts[0] + " " + parts[1]);
    if (frame.conversationList) return { ...frame, picker: true, heading,
      footer: nativeHeading(`${this.messages.changed ? "+new · " : ""}${this.status()} · Tap: open · Double: exit`), layoutKey: "basic:" + frame.layoutKey };
    return { ...frame, plain: true, heading, footer: nativeHeading(parts[4]) };
  }
  private makeFullNativeFrame(parts: string[]): NativeFrame {
    if (this.draftConfirmation) return { body: "", picker: true, confirmation: true, sessionKey: this.state?.session.key,
      heading: "Send and leave editor?", entries: [{ key: "send", label: "Send & exit" }, { key: "discard", label: "Exit only" }],
      layoutKey: "composer-confirm:" + this.state?.session.key };
    if (this.mode === "sessions" && !this.sessionLoading && !this.sessionError && this.sessions.length) {
      this.sessionPage = Math.min(this.sessionPage, Math.floor((this.sessions.length - 1) / 18));
      const start = this.sessionPage * 18;
      const entries: NativeListEntry[] = this.sessions.slice(start, start + 18).map(session => ({
        key: session.key, label: nativeLabel(`${session.source ? session.source.name + " · " : ""}${session.name || session.preview || "Untitled"} · ${session.runtimeStatus}`),
      }));
      if (start + 18 < this.sessions.length) entries.push({ page: this.sessionPage + 1, label: "Next sessions →" });
      if (this.sessionPage) entries.push({ page: this.sessionPage - 1, label: "← Previous sessions" });
      return { body: "", entries, layoutKey: JSON.stringify(entries), picker: true,
        heading: this.sessionSwitching ? "Opening session…" : "Sessions" };
    }
    const key = this.state?.session.key || "";
    if (this.mode === "terminal" && !key) return { body: parts[2], plain: true, heading: "Even-Pilot", layoutKey: "connection-notice" };
    if (this.mode === "terminal" && !this.composer && !this.choice()) {
      const detail = this.messages.detail;
      if (detail) return { body: detail.parts[detail.part], sessionKey: key,
        layoutKey: `message:${key}:${detail.revision}:${detail.part}`, detail: { previous: detail.part > 0, next: detail.part < detail.parts.length - 1 } };
      // Freeze one acknowledged snapshot between batched updates. Native
      // navigation/reading holds it until the user returns to the input row.
      if (this.bridge) this.messages.hold();
      const entries = this.messageRows();
      return { body: "", entries, conversationList: true, sessionKey: key,
        layoutKey: "messages:" + JSON.stringify([key, entries]) };
    }
    const content = parts[2] + (parts[3] ? `\n▶ ${parts[3]}` : "");
    return { body: nativeBody(content), sessionKey: this.mode === "terminal" ? key : undefined,
      picker: this.mode === "sessions", heading: this.mode === "sessions" ? "Sessions" : undefined,
      layoutKey: this.mode === "sessions" ? "session-notice" : `${this.composer ? "composer" : "terminal"}:${key}` };
  }
  private parts(): string[] {
    this.syncMessages();
    this.refreshMessages();
    // Fit once against actual pixels in the renderer/native heading. An earlier
    // fixed character budget discarded title text while the display had room.
    const title = (this.mode === "sessions" ? "Sessions" : this.state?.session.key ? sessionHeader(this.state) : "Even-Pilot").replace(/\s+/g, " ").trim().slice(0, 512);
    if (this.draftConfirmation) return ["", "Send and leave editor?",
      ["Send & exit", "Exit only"].map((label, index) => (index === this.draftConfirmation!.selected ? "> " : "  ") + label).join("\n"), "", "Tap: confirm · Double: back"];
    if (this.mode === "sessions") {
      const start = Math.floor(this.selection / 5) * 5;
      const body = this.sessionLoading ? "Loading…" : this.sessionSwitching ? "Opening session…" : this.sessionError ? shortLine(this.sessionError, 90) : !this.sessions.length ? "No available watched sessions.\nOpen a watched terminal on your computer."
        : this.sessions.slice(start, start + 5).map((session, index) => `${start + index === this.selection ? ">" : " "} ${shortLine((session.source ? session.source.name + " · " : "") + (session.name || session.preview || "Untitled"), 27)}  ${session.runtimeStatus.toUpperCase()}`).join("\n");
      const footer = this.sessionError ? "Tap: retry   Double tap: back" : this.sessions.length ? "Tap: select   Double tap: back" : "Double tap: back";
      return ["", title, body, "", footer];
    }
    if (!this.state?.session.key) return ["", title, this.online ? "Choose a watched session from the Sessions menu." : "Connecting to desktop…", "", "Menu: Sessions"];
    if (this.composer) {
      const pulse = this.composer.phase === "recording" ? (Math.floor(Date.now() / 700) % 2 ? " ●" : " ○") : "";
      return [this.header(), title, this.lines((this.composer.text || "Tap to record a sentence.") + pulse).slice(this.composerLine, this.composerLine + 7).join("\n"), "", this.composer.hint];
    }
    const choice = this.choice();
    if (choice) return [this.header(), title,
      this.canAnswerChoice(choice) ? this.choiceBody(choice, this.choiceIndex) : `${choice.title}\nReview details and answer on phone.`, "",
      this.choiceNotice || (this.canAnswerChoice(choice) ? "Scroll: choose · Tap: confirm · 2 taps: back" : "Answer on phone · 2 taps: back")];
    const detail = this.messages.detail;
    if (detail) return [this.header(), title, detail.parts[detail.part], "",
      `${this.messages.changed ? "+new · " : ""}${detail.parts.length > 1 ? `${detail.part + 1}/${detail.parts.length} · Menu: parts · ` : ""}Double: back`];
    const rows = this.messageRows();
    const body = rows.map((row, index) => (this.messages.selected === index ? "> " : "  ") + row.label).join("\n");
    const hint = `${this.messages.changed ? "+new · " : ""}Tap: open · Double: exit`;
    const older = this.messages.history.limited ? " · Older: phone/PC" : "";
    return [this.header(), title, body, "", `${hint} · ${this.statusLabel()} ${this.status().replace(/^\S+ ?/, "")}${older}`];
  }

  private publishPreview(parts: string[]) {
    const key = JSON.stringify([this.mode, ...parts]);
    if (key === this.lastPreview) return;
    this.lastPreview = key;
    this.preview(`${parts[0]} ${parts[1]}`.trim(), `${parts[2]}${parts[3] ? `\n▶ ${parts[3]}` : ""}\n\n${parts[4]}`, this.mode);
  }
  private schedule(interactive = true) {
    this.reportViewed();
    if (this.disposed) return;
    this.interactivePending ||= interactive;
    // Streaming uses one latest snapshot, including wrapping/preview work.
    // User input and lifecycle changes can advance a pending background frame.
    if (interactive || !this.renderer) this.publishPreview(this.parts());
    if (this.busy) this.dirty = true;
    if (this.paused || !this.renderer || this.busy) return;
    const now = Date.now(), at = Math.max(now + 60, this.interactivePending ? 0 : this.lastFlushAt + 250);
    if (this.timer && this.timerAt <= at) return;
    clearTimeout(this.timer); this.timerAt = at;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, at - now);
  }
  private reportViewed() {
    const key = this.state?.session.key;
    const mounted = this.nativeFrame && this.nativeFrame.sessionKey === key && nativeTexts(this.nativeFrame).every(text =>
      this.lastNativeTexts.get(text.id) === JSON.stringify([text.content, text.color]));
    this.options.viewed?.(key && this.bridge && this.online && this.pageCreated && mounted && this.mode === "terminal"
      && this.deviceConnected !== false && !this.disposed && !this.failures ? key : undefined);
  }
  private async flush() {
    if (!this.renderer || this.paused || this.disposed || this.busy || Date.now() < this.retryAt) return;
    const parts = this.parts(); this.busy = true; this.dirty = false;
    this.interactivePending = false; this.lastFlushAt = Date.now(); this.publishPreview(parts);
    const epoch = this.displayEpoch;
    try {
      let frame = this.makeNativeFrame(parts);
      // Prepare PNGs before a page replacement clears the old pixels, so the
      // first bar can be submitted immediately after the native page call.
      this.renderPreview(frame, parts);
      if (this.bridge && this.deviceConnected !== false) {
        if (!this.pageCreated || !this.nativeFrame || nativeLayoutKey(frame) !== nativeLayoutKey(this.nativeFrame)) {
          frame = await this.mountNativeFrame(frame, epoch);
        }
        if (frame.picker && frame.heading !== this.lastNativeHeading) {
          const accepted = await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 6, containerName: "pilot-heading", content: frame.heading }));
          if (!accepted) throw new DisplayError("heading update rejected");
          if (epoch === this.displayEpoch) this.lastNativeHeading = frame.heading || "";
        }
        if (frame.picker && frame.conversationList) {
          const signature = frame.footer || "";
          if (this.lastNativeTexts.get(7) !== signature) {
            const accepted = await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 7, containerName: "pilot-hint", content: signature }));
            if (!accepted) throw new DisplayError("hint update rejected");
            if (epoch === this.displayEpoch) this.lastNativeTexts.set(7, signature);
          }
        }
        for (const text of nativeTexts(frame)) {
          const signature = JSON.stringify([text.content, text.color]);
          if (this.lastNativeTexts.get(text.id) === signature) continue;
          const accepted = await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID: text.id, containerName: text.name, content: text.content, textColor: text.color }));
          if (!accepted) throw new DisplayError(`text update rejected (${text.id})`);
          if (epoch === this.displayEpoch) this.lastNativeTexts.set(text.id, signature);
        }
        // Move presence/gesture identity only after the new session's body is acknowledged.
        if (epoch === this.displayEpoch) this.nativeFrame = frame;
      }
      // A rejected layout may have switched to the image-free basic view.
      this.renderPreview(frame, parts);
      const tiles = frame.picker || frame.plain ? [] : this.renderedTiles;
      const currentPage = () => {
        if (this.disposed || this.paused || !this.bridge || this.deviceConnected === false || epoch !== this.displayEpoch) return false;
        const latest = this.makeNativeFrame();
        // New body text in the same editor must not strand half a status bar.
        return latest.layoutKey === frame.layoutKey && latest.sessionKey === frame.sessionKey;
      };
      // Reserve only one bar at a time, not the whole frame. Storage requests
      // cannot split its halves; microphone/menu work gets a turn between bars.
      for (let start = 0; start < tiles.length; start += 2) {
        if (!currentPage()) break;
        const pending = tiles.slice(start, start + 2).map((tile, offset) => ({ tile, index: start + offset }))
          .filter(({ tile, index }) => tile.png !== this.last[index])
          .map(({ tile, index }) => ({ tile, index, update: new ImageRawDataUpdate({ containerID: tile.id, containerName: tile.name, imageData: pngBytes(tile.png) }) }));
        if (!pending.length) continue;
        await bridgeBatch(this.bridge!, async bridge => {
          for (const { tile, index, update } of pending) {
            // Recheck after queueing and every send: exit/session changes win.
            if (!currentPage()) break;
            const result = await bridge.updateImageRawData(update);
            if (result !== "success") throw new DisplayError(`image update rejected (${tile.id})`);
            if (epoch === this.displayEpoch) this.last[index] = tile.png;
          }
        });
      }
      if (this.deviceConnected !== false) {
        if (this.failures) this.connectedNotice();
        this.failures = 0;
      }
    } catch (error) { this.displayFailed(error); }
    finally { this.busy = false; this.rebuilding = false; this.reportViewed(); }
    if (this.dirty || epoch !== this.displayEpoch || this.parts().some((part, index) => part !== parts[index])) this.schedule(false);
  }
  private renderPreview(frame: NativeFrame, parts: string[]) {
    const previewKey = JSON.stringify([!!frame.picker, !!frame.plain, frame.footer, ...parts]);
    if (previewKey === this.lastRendered) return;
    this.renderedTiles = this.renderer!.render({ prefix: parts[0], title: parts[1], body: parts[2], status: parts[3], footer: frame.footer || parts[4], bodyPadding: frame.detail ? G2_READING_PADDING : 0, list: frame.conversationList || frame.confirmation ? { labels: frame.entries!.map(entry => entry.label), selected: frame.confirmation ? this.draftConfirmation?.selected || 0 : this.messages.selected } : undefined }, Date.now(), !frame.picker && !frame.plain);
    this.lastRendered = previewKey;
    if (this.renderer!.canvas) this.options.frame?.(this.renderer!.canvas);
  }
  dispose() {
    this.taps.reset();
    this.disposed = true; this.sessionRequest++; clearTimeout(this.timer); clearInterval(this.clock);
    this.wrapped.clear();
    this.reportViewed();
    this.options.input?.cancel?.(); this.unsubscribe?.(); this.unsubscribeDevice?.(); this.bridge = undefined; this.connection("G2 disconnected");
  }
}
