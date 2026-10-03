import "./style.css";
import "./hub.css";
import {
  initialState,
  type RuntimeState,
} from "../../../packages/cockpit-state/types.js";
import {
  sessionLabel,
  toolLabel,
  statusBar,
} from "../../../packages/cockpit-state/selectors.js";
import { type Connection } from "./bridge/client.js";
import { FleetClient } from "./bridge/fleet.js";
import { ConnectionSettings } from "./bridge/settings.js";
import { consumePairingUrl } from "./bridge/pairing.js";
import { G2Display, type G2InputTrace } from "./g2/display.js";
import type { SessionsPanel, SessionSummary } from "./sessions/panel.js";
import { VoiceSettings } from "./voice/settings.js";
import { VoiceController, type VoiceView } from "./voice/controller.js";
import { InteractionPanel } from "./interactions/panel.js";
import type { InteractionAnswer } from "../../../packages/cockpit-state/interactions.js";
import { AudioInputSource, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { HubShell } from "./hub-shell.js";

const desktopMode = import.meta.env.MODE !== "hub" && (new URLSearchParams(location.search).get("desktop") === "1" ||
  (["127.0.0.1", "localhost"].includes(location.hostname) && location.port === "4317"));
document.body.classList.toggle("desktop-mode", desktopMode);

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="live-status" aria-label="Live agent status"><div class="live-status-inner"><span id="running-count" title="Running monitored agents">? AGENTS</span><span id="runtime-status">OFFLINE</span><time id="status-time" aria-label="Time in current status">--:--</time></div></div>
  <header class="masthead"><a class="brand" href="./"><span class="brand-icon" aria-hidden="true"></span><span>Even-<b>Pilot</b><small>AGENTS, IN SIGHT.</small></span></a><div class="header-right"><span id="link-state" class="connection">Not connected</span><button id="open-settings" class="subtle">Connection <span>↗</span></button></div></header>
  <main><div class="page-heading"><div><div class="eyebrow">[ LOCAL AGENT CONSOLE ]</div><h1>KEEP AGENTS IN SIGHT.</h1><p>Your sessions. Desktop / phone / G2.</p></div><div class="session-indicator"><span class="dot"></span><span id="session-label">No session connected</span></div></div>
  <div id="notice" role="status" hidden></div>
  <div class="workspace"><section class="terminal-panel"><div class="panel-heading"><div><span class="section-number">01</span><h2>Terminal</h2></div></div>
    <div id="transcript" class="transcript" role="log" aria-label="Agent conversation"></div>
    <form id="prompt-form" class="composer"><label for="prompt" class="sr-only">Message session</label><textarea id="prompt" placeholder="> Enter a prompt..." rows="3" maxlength="32000"></textarea><div class="composer-bottom"><span id="composer-hint">Connect your desktop bridge to begin</span><div><button id="stop" type="button" class="subtle" disabled>■ Stop</button><button id="send" type="submit" class="primary" disabled>Send prompt <span>↗</span></button></div></div></form>
    <div class="panel-footer"><span>Multiple sessions. Every surface in sync.</span><span>↵ Send · Shift + ↵ New line</span></div>
  </section>
  <aside><section class="glasses-card"><div class="panel-heading"><div><span class="section-number">02</span><h2>G2 output</h2></div><span class="tiny-label">G2</span></div><div class="g2-screen"><div class="display-label"><span>LIVE DISPLAY PREVIEW</span><span id="g2-mode">STATUS</span></div><div id="g2-status" class="g2-status"></div><pre id="g2-preview"></pre></div><div class="glasses-footer"><span id="g2-connection">Preview · open in Even Hub for G2</span><button id="toggle-display" class="text-button">Tap / Open ↵</button></div><div class="g2-controls" aria-label="G2 preview controls"><button id="g2-sessions" class="text-button">Sessions</button><button id="g2-previous" class="text-button" aria-label="G2 previous">↑</button><button id="g2-next" class="text-button" aria-label="G2 next">↓</button><button id="g2-back" class="text-button">Back</button></div></section>
  <section class="details-card"><div class="panel-heading"><div><span class="section-number">03</span><h2>Runtime</h2></div></div><dl><div><dt>Activity</dt><dd id="tools">No active tools</dd></div><div><dt>Model</dt><dd id="model">—</dd></div><div><dt>Project</dt><dd id="cwd">—</dd></div><div><dt>Session</dt><dd id="session-id">—</dd></div></dl><div class="session-actions"><button id="manage-sessions" class="outline" disabled>Switch session ↗</button><button id="new-session" class="outline" disabled>＋ New</button></div><p id="monitor-summary" class="caption">Choose a session to open it. History is available separately.</p></section>
  <section class="notification-card"><span class="notification-icon">◌</span><div><h3>JOB DONE. YOU KNOW.</h3><p>Point your Glance watcher at this bridge to get a notification when a session finishes.</p><button id="show-glance" class="text-button">Glance connection details ↗</button></div></section></aside></div>
  <footer class="page-footer"><span>EVEN-PILOT <span class="version">/ 1.1.1</span></span><span>WINDOWS / LINUX / EVEN HUB</span></footer></main>
  <dialog id="settings"><form id="connection-form"><div class="dialog-heading"><div><div class="eyebrow">CONNECT YOUR COCKPIT</div><h2>Desktop bridge</h2></div><button id="close-settings" type="button" class="subtle" aria-label="Close settings">✕</button></div><p>Enter the desktop bridge address and connection key below. Use the desktop LAN or Tailscale address.</p><label for="bridge-url">Bridge URL</label><input id="bridge-url" type="url" required placeholder="Paste desktop Bridge URL"><label for="bridge-token">Connection key</label><input id="bridge-token" type="password" required autocomplete="off" placeholder="Paste the connection key"><p class="caption">URL and key are saved on this phone and restored when you reopen the app. Forget connection removes them.</p><button class="primary full" type="submit">Save computer ↗</button><div class="glance-details"><h3>Glance notifications</h3><p>Registration / polling URL: <code id="glance-url">http://&lt;PC-IP&gt;:4317/api/glance</code></p><p>Credential: use the <b>same connection key</b> as this app, or scan the same desktop QR in Glance. Choose a unique watcher name.</p><p class="caption">Choose PUSH in Glance, then Save and register. Each watched session returning to zero active agents triggers a push, except the session currently open on G2. POLL remains available at intervals of 15 minutes or longer.</p></div></form></dialog>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const dialog = $<HTMLDialogElement>("settings");
const updatesButton = document.createElement("button"); updatesButton.type = "button"; updatesButton.className = "subtle"; updatesButton.textContent = "Updates";
document.querySelector(".header-right")!.append(updatesButton);
void import("./updates/settings.js").then(({ UpdateSettings }) => { new UpdateSettings(() => client, updatesButton, desktopMode ? location.origin : undefined); });
const notificationSettingsButton = document.createElement("button");
notificationSettingsButton.type = "button"; notificationSettingsButton.className = "outline"; notificationSettingsButton.textContent = "Notification routing";
document.querySelector(".glance-details")!.append(notificationSettingsButton);
let notificationSettings: import("./notifications/settings.js").NotificationSettings | undefined;
notificationSettingsButton.onclick = async () => {
  notificationSettings ||= new (await import("./notifications/settings.js")).NotificationSettings(() => client);
  notificationSettings.open();
};
dialog.querySelector("h2")!.textContent = "Computers";
dialog.querySelector("form > p")!.textContent = "Add each computer once. Sessions from all saved computers appear together.";
dialog.querySelector(".caption")!.textContent = "All computer URLs and keys are saved on this device. Remove only forgets this connection; it does not stop the computer or its sessions.";
const hostsList = document.createElement("div"); hostsList.className = "connection-hosts"; hostsList.setAttribute("aria-label", "Saved computers");
const addHostButton = document.createElement("button"); addHostButton.type = "button"; addHostButton.className = "outline"; addHostButton.textContent = "+ Add computer";
dialog.querySelector('label[for="bridge-url"]')!.before(hostsList, addHostButton);
if (desktopMode) {
  $("open-settings").textContent = "Bridge settings";
  document.querySelector(".page-heading")!.setAttribute("hidden", "");
  document.querySelector(".page-heading p")!.textContent = "Monitor sessions. Open a terminal. Send a prompt.";
  document.querySelector(".terminal-panel h2")!.textContent = "Send to selected terminal";
  document.querySelector(".panel-footer span")!.textContent = "Full conversation stays in the native terminal.";
  $<HTMLTextAreaElement>("prompt").rows = 1;
}
let state: RuntimeState = initialState();
const hub = desktopMode ? undefined : new HubShell(view => {
  if (view === "sessions") void openSessions("browse");
  else render();
});
let online = false,
  pending = false;
let client: FleetClient | undefined;
let config: Connection | undefined;
const connectionSettings = new ConnectionSettings(() => localStorage, () => sessionStorage);
let audioBridge: EvenAppBridge | undefined;
let voice: VoiceController | undefined;
const voiceSettings = !desktopMode ? new VoiceSettings(() => voice?.cancel()) : undefined;
const voiceReview = document.createElement("section");
voiceReview.className = "voice-review"; voiceReview.hidden = true;
voiceReview.innerHTML = '<h3>Voice reply</h3><p role="status"></p><label class="sr-only" for="voice-draft">Review voice reply</label><textarea id="voice-draft" rows="3" maxlength="32000"></textarea><div class="voice-actions"><button type="button" class="primary" data-send>Send voice reply</button><button type="button" class="outline" data-cancel>Cancel</button></div>';
if (!desktopMode) $("prompt-form").after(voiceReview);
const voiceButton = document.createElement("button"); voiceButton.type = "button"; voiceButton.className = "subtle"; voiceButton.textContent = "Voice";
voiceButton.onclick = () => { voice?.cancel(); voiceSettings?.open(); };
if (!desktopMode) document.querySelector(".header-right")!.append(voiceButton);
try {
  config = consumePairingUrl();
} catch {
  /* A malformed QR must never start a connection to an arbitrary service. */
}
const pairedOnLaunch = !!config;
async function respondToInteraction(key: string, answer: InteractionAnswer) {
  if (!client || !online || state.session.key !== key) throw new Error("Session changed or disconnected");
  await client.request("/api/interaction/respond", { sessionKey: key, ...answer });
}
const interactions = new InteractionPanel(respondToInteraction);
$("prompt-form").before(interactions.element);
if (!config) config = connectionSettings.current();
const g2Canvas = document.createElement("canvas"); g2Canvas.width = 576; g2Canvas.height = 288;
g2Canvas.className = "g2-canvas"; g2Canvas.setAttribute("aria-label", "G2 display preview");
$("g2-preview").before(g2Canvas);
$("g2-preview").hidden = true; $("g2-status").hidden = true;
const inputTrace: G2InputTrace[] = [];
const g2Diagnostics = document.createElement("details"); g2Diagnostics.className = "g2-diagnostics";
g2Diagnostics.innerHTML = '<summary>G2 input diagnostics</summary><p class="caption">Recent gestures only. No conversation, audio or connection keys.</p><textarea readonly rows="6" aria-label="Recent G2 gestures"></textarea><button type="button" class="text-button">Copy diagnostics</button>';
document.querySelector(".g2-controls")!.after(g2Diagnostics);
const diagnosticText = g2Diagnostics.querySelector("textarea")!;
function refreshInputTrace() {
  diagnosticText.value = JSON.stringify({ version: "1.1.1", events: inputTrace }, null, 2);
}
g2Diagnostics.ontoggle = () => { if (g2Diagnostics.open) refreshInputTrace(); };
g2Diagnostics.querySelector("button")!.onclick = async () => {
  refreshInputTrace();
  try { await navigator.clipboard.writeText(diagnosticText.value); }
  catch { diagnosticText.focus(); diagnosticText.select(); }
};
const glasses = new G2Display(
  (header, text, mode) => {
    $("g2-status").textContent = header;
    $("g2-preview").textContent = text;
    $("g2-mode").textContent = mode.toUpperCase();
  },
  (text) => {
    $("g2-connection").textContent = text;
  },
  {
    list: async () => {
      if (!client || !online) throw new Error("Connect to your desktop bridge first.");
      return (await client.request("/api/sessions") as { sessions: SessionSummary[] }).sessions;
    },
    open: key => changeSession("/api/session/resume", { key, watchedOnly: true }),
  },
  {
    frame: canvas => { g2Canvas.getContext("2d")?.drawImage(canvas, 0, 0); },
    inputTrace: trace => {
      inputTrace.push(trace); if (inputTrace.length > 60) inputTrace.shift();
      if (g2Diagnostics.open) refreshInputTrace();
    },
    viewed: key => client?.setViewedSession(key),
    respond: respondToInteraction,
    interrupt: async key => {
      if (!client || !online || state.session.key !== key) throw new Error("Session changed or disconnected");
      await client.request(`/api/runtime/${encodeURIComponent(key)}/interrupt`, {});
    },
    ready: bridge => {
      audioBridge = bridge; void voiceSettings?.attachBridge(bridge);
      void restorePhoneConnection(bridge);
    },
    input: {
      open: () => voice?.open(), toggleRecording: () => { void voice?.toggleRecording(); }, hasDraft: () => voice?.hasDraft() ?? false,
      send: () => { void voice?.confirm(); }, finish: () => voice?.finish(), startDeleting: () => voice?.startDeleting(), stopDeleting: () => voice?.stopDeleting(),
      pause: () => voice?.pause(), cancel: () => voice?.cancel(), audio: pcm => voice?.audio(pcm),
    },
  },
);
function showVoice(view: VoiceView) {
  glasses.setComposer(view.phase === "idle" || view.background ? undefined : view);
  voiceReview.hidden = view.phase === "idle";
  voiceReview.querySelector("p")!.textContent = view.hint;
  const draft = voiceReview.querySelector("textarea")!;
  if (draft.value !== view.text) draft.value = view.text;
  draft.readOnly = view.phase !== "review";
  voiceReview.querySelector<HTMLButtonElement>("[data-send]")!.disabled = view.phase !== "review" || !view.text.trim();
}
voice = new VoiceController({
  config: () => voiceSettings?.config() || { provider: "whisper", key: "", language: "" },
  target: () => online && state.connected && state.capabilities?.prompt !== false && state.session.key && config && state.monitoring?.sessions.some(s => s.key === state.session.key && s.monitored)
    ? { key: state.session.key, connection: config.url } : undefined,
  mic: open => audioBridge ? audioBridge.audioControl(open, AudioInputSource.Glasses) : Promise.resolve(false),
  view: showVoice,
  send: async (text, target) => {
    if (!client || !online || config?.url !== target.connection || state.session.key !== target.key || pending) throw new Error("Session changed");
    pending = true; render();
    try { await client.request("/api/prompt", { text, sessionKey: target.key, source: "g2" }); }
    finally { pending = false; render(); }
  },
});
voiceReview.querySelector<HTMLButtonElement>("[data-send]")!.onclick = () => { void voice?.confirm(); };
voiceReview.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => voice?.cancel();
voiceReview.querySelector("textarea")!.oninput = event => voice?.edit((event.target as HTMLTextAreaElement).value);
if (!desktopMode) void glasses.init().catch(() => {
  $("g2-connection").textContent = "G2 unavailable · browser preview active";
});
let sessions: SessionsPanel | undefined;
let sessionsLoading: Promise<SessionsPanel> | undefined;
async function openSessions(mode: "browse" | "new") {
  try {
    sessionsLoading ??= import("./sessions/panel.js").then(({ SessionsPanel }) => {
      sessions = new SessionsPanel({ client: () => client, changed: notice, busy: value => { pending = value; render(); },
        mount: hub?.sessions, opened: hub ? () => { hub.show("conversation"); render(); } : undefined, connect: openSettings });
      return sessions;
    });
    const panel = await sessionsLoading;
    if (mode === "browse") hub?.show("sessions");
    panel.update(state, online); panel.open(mode);
  } catch (error) { sessionsLoading = undefined; notice(error instanceof Error ? error.message : "Session manager unavailable"); }
}
let desktopSessions: import("./sessions/desktop.js").DesktopSessions | undefined;
if (desktopMode) {
  const [, { DesktopSessions }] = await Promise.all([import("./desktop.css"), import("./sessions/desktop.js")]);
  desktopSessions = new DesktopSessions(() => client, notice, () => { void openSessions("new"); });
  const qrButton = document.createElement("button"); qrButton.className = "primary"; qrButton.textContent = "Phone URL & key";
  document.querySelector(".header-right")!.append(qrButton);
  qrButton.onclick = async () => {
    if (!client || !online) { openSettings(); return; }
    qrButton.disabled = true;
    try { const { showPairing } = await import("./bridge/desktop-pairing.js"); await showPairing(client); }
    catch (error) { notice(error instanceof Error ? error.message : "Connection code unavailable"); }
    finally { qrButton.disabled = false; }
  };
}

function notice(message: string) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
async function changeSession(path: string, data: unknown) {
  if (!client || !online) throw new Error("Connect to your desktop bridge first.");
  if (pending) throw new Error("Another action is in progress.");
  pending = true; render();
  try {
    state = await client.request(path, data) as RuntimeState;
    render(); notice("Session opened. Enter your next task.");
    return state;
  } finally { pending = false; render(); }
}
function renderStatus() {
  const bar = statusBar(state, online);
  $("running-count").textContent = bar.agents;
  $("runtime-status").textContent = bar.status;
  $("status-time").textContent = bar.elapsed;
  $("status-time").title = bar.status === "IDLE" ? "Time since watched sessions became idle" : "Time in current run or status";
}
const statusClock = setInterval(renderStatus, 1000);
let transcriptSignature = "";
let transcriptSession = "";
function render() {
  interactions.update(state, online);
  voice?.sync();
  const busy =
    state.main.status === "running" || state.main.status === "waiting";
  const ready = online && state.connected;
  const hosts = client?.hosts() || [], connectedHosts = hosts.filter(host => host.online).length;
  $("link-state").textContent = hosts.length ? `${connectedHosts}/${hosts.length} computers connected` : "Not connected";
  renderStatus();
  $("session-label").textContent = state.session.key
    ? `${state.source ? state.source.name + " · " : ""}${sessionLabel(state)}`
    : "No session connected";
  if (desktopMode) document.querySelector(".terminal-panel h2")!.textContent = state.session.key ? `Prompt → ${state.source ? state.source.name + " · " : ""}${sessionLabel(state)}` : "Select a session to send a prompt";
  $("tools").textContent = toolLabel(state);
  $("model").textContent = (state.source ? state.source.name + " · " : "") + (state.session.tunnel || "pi").toUpperCase() + " · " + (state.session.model || "—");
  $("cwd").textContent = state.session.cwd || "—";
  $("session-id").textContent = state.session.id || "—";
  $<HTMLButtonElement>("send").disabled = !ready || busy || pending || state.capabilities?.prompt === false;
  $<HTMLButtonElement>("stop").disabled = !ready || !busy || state.capabilities?.interrupt === false;
  $<HTMLButtonElement>("new-session").disabled = !online || (busy && !state.monitoring) || pending;
  $<HTMLButtonElement>("manage-sessions").disabled = !online || pending;
  sessions?.update(state, online);
  $("monitor-summary").textContent = state.monitoring
    ? `${state.monitoring.watched} monitored · ${state.monitoring.running} running. Prompts automatically add a session; cancel monitoring in the session list.`
    : "Choose a session to open it. History is available separately.";
  $("composer-hint").textContent = state.commandStatus || (state.capabilities?.prompt === false ? "Monitoring this session. Continue in its original terminal." : !ready
    ? online ? "Choose a session to begin" : "Connect your desktop bridge to begin"
    : busy
      ? state.capabilities?.interrupt === false ? "Agent is working. Use Ctrl+C in its terminal to stop." : "Agent is working. You can stop this run."
      : "Ready when you are");
  renderHosts();
  if (desktopMode) { desktopSessions?.update(state); return; }
  glasses.update(state, online);
  // The session browser is the phone's home. Build conversation DOM on demand.
  if (hub?.view !== "conversation") return;
  const signature = JSON.stringify([state.session.key, state.session.tunnel, ready, online, state.transcript,
    state.assistantOpen, state.currentAssistantText, state.main.error]);
  if (signature === transcriptSignature) return;
  transcriptSignature = signature;
  const log = $("transcript");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const sameSession = transcriptSession === (state.session.key || "");
  const expandedTools = new Set(sameSession ? [...log.querySelectorAll<HTMLDetailsElement>("details[data-tool-group][open]")].map(details => details.dataset.toolGroup) : []);
  transcriptSession = state.session.key || "";
  log.replaceChildren();
  if (!state.transcript.length && !state.assistantOpen) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<div class="orbit" aria-hidden="true"></div><div class="eyebrow">[ AWAITING INPUT ]</div><h2>${ready ? "SYSTEM READY." : online ? "CHOOSE A SESSION." : "CONNECT TO DESKTOP."}</h2><p>${ready ? "Send a prompt to this session. Its response and tool activity will appear here as they happen." : online ? "Open a saved session or start a new one." : "Connect to Even-Pilot on your computer.<br>Follow its progress here, or take it with you on G2."}</p>`;
    if (!ready) {
      const button = document.createElement("button");
      button.className = "outline";
      button.textContent = online ? "Choose a session ↗" : "Connect your bridge ↗";
      button.onclick = online ? () => void openSessions("browse") : openSettings;
      empty.append(button);
    }
    log.append(empty);
  }
  const add = (role: string, text: string, outcome?: string, target: HTMLElement = log) => {
    if (!text) return;
    const entry = document.createElement("article");
    entry.className = `message ${role}`;
    const label = document.createElement("div");
    label.className = "message-label";
    label.textContent =
      role === "user" ? "YOU" : role === "assistant" ? (state.session.tunnel || "pi").toUpperCase() : "TOOL";
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = text;
    if (outcome) {
      const badge = document.createElement("span");
      badge.className = "tool-outcome";
      badge.textContent = outcome;
      content.append(badge);
    }
    entry.append(label, content);
    target.append(entry);
  };
  for (let index = 0; index < state.transcript.length;) {
    const entry = state.transcript[index++];
    if (entry.role !== "tool") { add(entry.role, entry.text, entry.outcome); continue; }
    const tools = [entry];
    while (state.transcript[index]?.role === "tool") tools.push(state.transcript[index++]);
    const details = document.createElement("details"), summary = document.createElement("summary"), content = document.createElement("div");
    details.className = "tool-group"; details.dataset.toolGroup = String(entry.id);
    details.open = expandedTools.has(String(entry.id));
    const running = tools.filter(tool => tool.outcome === "running").length, failed = tools.filter(tool => tool.outcome === "failed").length;
    summary.textContent = `Tools · ${tools.length} call${tools.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}${failed ? ` · ${failed} failed` : ""}`;
    details.append(summary, content); log.append(details);
    let rendered = false;
    const expand = () => {
      if (!details.open || rendered) return;
      rendered = true;
      for (const tool of tools) add(tool.role, tool.text, tool.outcome, content);
    };
    details.ontoggle = expand; expand();
  }
  if (state.assistantOpen) add("assistant", state.currentAssistantText);
  if (state.main.error) add("error", state.main.error);
  if (atBottom) log.scrollTop = log.scrollHeight;
}
function openSettings() {
  $("connection-error")?.remove();
  $<HTMLInputElement>("bridge-url").value = config?.url || "";
  $<HTMLInputElement>("bridge-token").value = config?.token || "";
  updateGlanceUrl();
  renderHosts();
  dialog.showModal();
}
function updateGlanceUrl() {
  const origin = $<HTMLInputElement>("bridge-url").value.replace(/\/$/, "");
  $("glance-url").textContent = origin ? origin + "/api/glance" : "—";
}
let connectionAttempt = 0;
async function restorePhoneConnection(bridge: EvenAppBridge) {
  const attempt = connectionAttempt;
  await connectionSettings.attachBridge(bridge);
  if (attempt === connectionAttempt && !pairedOnLaunch) await restoreConnections();
}
function fleet() {
  if (client) return client;
  const candidate = new FleetClient(
    (nextState) => {
      if (client !== candidate) return;
      state = nextState;
      config = candidate.activeConnection();
      render();
    },
    (connected, error) => {
      if (client !== candidate) return;
      online = connected;
      if (error) notice(error);
      else if (connected) notice("");
      render();
    },
    (completion) => {
      if (client !== candidate) return;
      notice(`${completion.outcome}: ${completion.session}`);
    },
    url => { voice?.cancel(); void connectionSettings.select(url); },
  );
  client = candidate; glasses.setStorageScope("computers"); return candidate;
}
async function restoreConnections() {
  const saved = connectionSettings.all(), active = connectionSettings.current()?.url, target = fleet();
  for (const existing of target.connections()) if (!saved.some(item => item.url === existing.url)) target.remove(existing.url);
  for (const next of saved) {
    if (!target.connections().some(item => item.url === next.url && item.token === next.token)) await target.add(next, true, false);
  }
  if (active && target.connections().some(item => item.url === active)) target.choose(active);
}
async function connect(next: Connection) {
  const attempt = ++connectionAttempt;
  const target = fleet();
  if (!target.connections().some(item => item.url === next.url) && target.connections().length >= 16) throw new Error("Remove a computer before adding another (maximum 16).");
  await target.add(next, false, true, () => attempt === connectionAttempt);
  if (attempt !== connectionAttempt) throw new Error("Connection attempt was replaced");
  const saved = await connectionSettings.save(next);
  if (!saved) notice("Connected, but this device could not save the computer. Try saving again.");
}
let hostsSignature = "";
function renderHosts() {
  const hosts = client?.hosts() || [], signature = JSON.stringify([hosts, client?.activeUrl()]);
  if (signature === hostsSignature) return;
  hostsSignature = signature; hostsList.replaceChildren();
  for (const host of hosts) {
    const row = document.createElement("div"); row.className = "connection-host";
    const info = document.createElement("div"), name = document.createElement("strong"), detail = document.createElement("small");
    name.textContent = `${host.name} · ${host.online ? "Connected" : "Reconnecting"}`;
    detail.textContent = host.url || ""; info.append(name, detail);
    if (host.warning) { const warning = document.createElement("small"); warning.textContent = host.warning; info.append(warning); }
    const actions = document.createElement("div"); actions.className = "connection-host-actions";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "text-button"; edit.textContent = "Settings";
    edit.onclick = () => { const saved = client?.connections().find(item => item.url === host.url); if (!saved) return;
      $<HTMLInputElement>("bridge-url").value = saved.url; $<HTMLInputElement>("bridge-token").value = saved.token; updateGlanceUrl(); };
    const choose = document.createElement("button"); choose.type = "button"; choose.className = "text-button";
    choose.textContent = client?.activeUrl() === host.url ? "Selected" : "Select";
    choose.disabled = client?.activeUrl() === host.url;
    choose.onclick = () => { voice?.cancel(); client?.choose(host.url!); };
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-button"; remove.textContent = "Remove";
    remove.onclick = () => { void removeConnection(host.url!); };
    actions.append(choose, edit, remove); row.append(info, actions); hostsList.append(row);
  }
}
async function removeConnection(url: string) {
  connectionAttempt++; voice?.cancel();
  const cleared = await connectionSettings.remove(url);
  client?.remove(url); config = client?.activeConnection();
  $<HTMLInputElement>("bridge-token").value = ""; $<HTMLInputElement>("bridge-url").value = ""; updateGlanceUrl();
  notice(cleared ? "Computer removed from this device. Its Watch settings and terminals are unchanged." : "Removed here, but saved storage could not be updated. Try again.");
}
$("open-settings").onclick = openSettings;
$("show-glance").onclick = openSettings;
$("close-settings").onclick = () => dialog.close();
dialog.addEventListener("close", () => { $<HTMLInputElement>("bridge-token").value = ""; });
addHostButton.onclick = () => {
  $("connection-error")?.remove(); $<HTMLInputElement>("bridge-token").value = ""; $<HTMLInputElement>("bridge-url").value = "";
  updateGlanceUrl(); $<HTMLInputElement>("bridge-url").focus();
};
$("bridge-url").oninput = updateGlanceUrl;
$("toggle-display").onclick = () => glasses.toggle();
$("g2-sessions").onclick = () => { void glasses.openSessions(); };
$("g2-previous").onclick = () => glasses.scroll(-1);
$("g2-next").onclick = () => glasses.scroll(1);
$("g2-back").onclick = () => glasses.back();
$("connection-form").onsubmit = async (event) => {
  event.preventDefault();
  const submit = $("connection-form").querySelector<HTMLButtonElement>('button[type="submit"]')!;
  if (submit.disabled) return;
  submit.disabled = true; submit.textContent = "Checking connection…";
  try {
    const url = new URL($<HTMLInputElement>("bridge-url").value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Enter an HTTP(S) bridge origin without a path");
    const next = {
      url: url.origin,
      token: $<HTMLInputElement>("bridge-token").value.trim(),
    };
    await connect(next);
    dialog.close();
  } catch (error) {
    $("connection-error")?.remove();
    const message = document.createElement("p");
    message.id = "connection-error";
    message.setAttribute("role", "alert");
    message.textContent =
      error instanceof Error ? error.message : "Invalid connection";
    $("connection-form").append(message);
  } finally { submit.disabled = false; submit.textContent = "Save computer ↗"; }
};
$("prompt-form").onsubmit = async (event) => {
  event.preventDefault();
  const prompt = $<HTMLTextAreaElement>("prompt");
  const text = prompt.value.trim();
  if (!client || !online || pending || !text || state.main.status === "running")
    return;
  pending = true;
  render();
  notice("");
  try {
    await client.request("/api/prompt", { text, sessionKey: state.session.key });
    if (prompt.value.trim() === text) prompt.value = "";
  } catch (error) {
    notice(error instanceof Error ? error.message : "Prompt failed");
  } finally {
    pending = false;
    render();
  }
};
$("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $<HTMLFormElement>("prompt-form").requestSubmit();
  }
};
$("stop").onclick = () => {
  const key = state.session.key;
  if (!key) return;
  void client
    ?.request(`/api/runtime/${encodeURIComponent(key)}/interrupt`, {})
    .catch((error) => notice(error.message));
};
$("new-session").onclick = () => void openSessions("new");
$("manage-sessions").onclick = () => void openSessions("browse");
window.addEventListener("pagehide", event => {
  client?.disconnect();
  voice?.cancel();
  if (!event.persisted) { clearInterval(statusClock); glasses.dispose(); desktopSessions?.close(); }
});
window.addEventListener("pageshow", event => { if (event.persisted) { client?.reconnect(); glasses.resync(); } });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) voice?.cancel();
  else { client?.reconnect(); glasses.resync(); }
});
render();
if (hub) void openSessions("browse");
const launchConnection = config;
void (async () => {
  await restoreConnections();
  if (pairedOnLaunch && launchConnection) await connect(launchConnection);
})().catch(error => { notice(error.message); openSettings(); });
$("connection-form").querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = "Save computer ↗";
