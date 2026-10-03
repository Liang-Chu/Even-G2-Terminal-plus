import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { VoiceConfig, VoiceProvider } from "./transcribe.js";

const STORAGE = "even-pilot.voice.v1";
type StorageBridge = Pick<EvenAppBridge, "getLocalStorage" | "setLocalStorage">;
interface SavedVoice {
  version: 1; updatedAt: number; provider: VoiceProvider; openaiModel: VoiceConfig["openaiModel"];
  language: VoiceConfig["language"]; keys: { whisper: string; elevenlabs: string };
}
function savedVoice(raw: string | null): SavedVoice | undefined {
  try {
    const value = JSON.parse(raw || "null");
    if (!value || !["whisper", "elevenlabs"].includes(value.provider) || value.version !== undefined && value.version !== 1) return;
    const updatedAt = value.version === 1 ? value.updatedAt : 0;
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) return;
    return { version: 1, updatedAt, provider: value.provider, language: ["zh", "en"].includes(value.language) ? value.language : "",
      openaiModel: value.openaiModel === "gpt-transcribe" ? "gpt-transcribe" : "whisper-1",
      keys: { whisper: typeof value.keys?.whisper === "string" ? value.keys.whisper.slice(0, 4096) : "",
        elevenlabs: typeof value.keys?.elevenlabs === "string" ? value.keys.elevenlabs.slice(0, 4096) : "" } };
  } catch { /* Invalid settings must not prevent connecting to a terminal. */ }
}
export class VoiceSettings {
  private provider: VoiceProvider = "whisper";
  private openaiModel: VoiceConfig["openaiModel"] = "whisper-1";
  private language: VoiceConfig["language"] = "";
  private keys = { whisper: "", elevenlabs: "" };
  private revision = 0;
  private saving = false;
  private record?: SavedVoice;
  private writes: Promise<unknown> = Promise.resolve();
  private bridge?: StorageBridge;
  private dialog!: HTMLDialogElement;
  constructor(private changed: () => void) {
    try { const record = savedVoice(localStorage.getItem(STORAGE)); if (record) this.load(record); } catch {}
  }
  private mount() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "voice-settings";
    this.dialog.innerHTML = `<form><div class="dialog-heading"><h2>Voice input</h2><button type="button" data-close class="subtle" aria-label="Close voice settings">✕</button></div>
      <p>Select New prompt to edit. Tap to start/stop recording, hold to delete. Double tap opens Send &amp; exit / Exit only, with Send &amp; exit selected. Confirm to return to the session; an empty draft sends nothing.</p>
      <label for="voice-provider">Speech service</label><select id="voice-provider"><option value="whisper">OpenAI</option><option value="elevenlabs">ElevenLabs Scribe</option></select>
      <div data-openai-model><label for="voice-model">Transcription model</label><select id="voice-model"><option value="whisper-1">Whisper · complete result</option><option value="gpt-transcribe">GPT Transcribe · stream text sooner</option></select></div>
      <p class="caption" data-model></p><label for="voice-key">API key</label><input id="voice-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096" placeholder="Paste your speech service key">
      <label for="voice-language">Language</label><select id="voice-language"><option value="">Auto · 中文 / English</option><option value="zh">中文</option><option value="en">English</option></select>
      <p class="caption">Your key and voice settings are saved on this phone and restored when you reopen the app. Clear all keys removes them. Audio goes directly to your selected service; your PC receives only the text you send.</p>
      <p role="status" data-status></p><div class="voice-actions"><button class="primary" type="submit">Save</button><button class="outline" type="button" data-clear>Clear all keys</button></div></form>`;
    document.body.append(this.dialog);
    this.dialog.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => this.dialog.close();
    this.dialog.addEventListener("close", () => { this.input("voice-key").value = ""; });
    this.select("voice-provider").onchange = () => this.fillKey();
    this.select("voice-model").onchange = () => this.modelHint();
    this.dialog.querySelector("form")!.onsubmit = event => { event.preventDefault(); void this.save(); };
    this.dialog.querySelector<HTMLButtonElement>("[data-clear]")!.onclick = () => { void this.clear(); };
  }
  private input(id: string) { return this.dialog.querySelector<HTMLInputElement>(`#${id}`)!; }
  private select(id: string) { return this.dialog.querySelector<HTMLSelectElement>(`#${id}`)!; }
  private status(text: string) { this.dialog.querySelector("[data-status]")!.textContent = text; }
  private load(record: SavedVoice) {
    this.record = record; this.provider = record.provider; this.language = record.language;
    this.openaiModel = record.openaiModel; this.keys = { ...record.keys };
  }
  async attachBridge(bridge: StorageBridge) {
    this.bridge = bridge; const revision = this.revision;
    try {
      const remote = savedVoice(await bridge.getLocalStorage(STORAGE));
      if (bridge !== this.bridge || revision !== this.revision || this.dialog?.open) return;
      if (remote && (!this.record || remote.updatedAt >= this.record.updatedAt)) this.load(remote);
      // Older, unversioned records remain readable and migrate once.
      if (this.record?.updatedAt === 0) this.load({ ...this.record, updatedAt: Math.max(1, Date.now()) });
      this.changed();
      if (this.record) await this.persist(this.record, revision, bridge);
    } catch {}
  }
  config(): VoiceConfig { return { provider: this.provider, key: this.keys[this.provider], language: this.language, openaiModel: this.openaiModel }; }
  open() {
    this.mount();
    this.select("voice-provider").value = this.provider; this.select("voice-language").value = this.language;
    this.select("voice-model").value = this.openaiModel!;
    this.fillKey(); this.status(""); this.dialog.showModal();
  }
  private fillKey() {
    const provider = this.select("voice-provider").value as VoiceProvider;
    this.input("voice-key").value = this.keys[provider];
    this.modelHint();
  }
  private modelHint() {
    const openai = this.select("voice-provider").value === "whisper";
    this.dialog.querySelector<HTMLElement>("[data-openai-model]")!.hidden = !openai;
    this.dialog.querySelector("[data-model]")!.textContent = openai
      ? `${this.select("voice-model").value} · api.openai.com · same OpenAI key; account model access required`
      : "scribe_v2 · api.elevenlabs.io";
  }
  private snapshot(): SavedVoice {
    return this.record = { version: 1, updatedAt: Math.max(1, Date.now(), (this.record?.updatedAt || 0) + 1),
      provider: this.provider, openaiModel: this.openaiModel, language: this.language, keys: { ...this.keys } };
  }
  private persist(record: SavedVoice, revision = this.revision, bridge = this.bridge): Promise<void> {
    const value = JSON.stringify(record);
    let fallback = false;
    try { localStorage.setItem(STORAGE, value); fallback = true; } catch {}
    const current = () => record === this.record && revision === this.revision && bridge === this.bridge;
    const write = async () => {
      if (!current()) return;
      if (bridge) {
        if (!await bridge.setLocalStorage(STORAGE, value)) throw new Error("App storage is unavailable.");
        // A delayed migration acknowledgement cannot delete a newer fallback.
        if (current()) try { localStorage.removeItem(STORAGE); } catch {}
      } else if (!fallback) throw new Error("App storage is unavailable.");
    };
    const pending = this.writes.then(write, write); this.writes = pending;
    return pending;
  }
  private async save() {
    if (this.saving) return;
    this.saving = true;
    this.revision++;
    this.provider = this.select("voice-provider").value as VoiceProvider;
    this.openaiModel = this.select("voice-model").value === "gpt-transcribe" ? "gpt-transcribe" : "whisper-1";
    this.language = this.select("voice-language").value as VoiceConfig["language"];
    this.keys[this.provider] = this.input("voice-key").value.trim();
    this.changed();
    try { await this.persist(this.snapshot()); this.dialog.close(); }
    catch { this.status("Could not update saved settings. Changes work for this launch. Reopen Voice and save again to update or remove stored keys."); }
    finally { this.saving = false; }
  }
  private async clear() {
    if (this.saving) return;
    this.saving = true;
    this.revision++; this.keys = { whisper: "", elevenlabs: "" };
    this.input("voice-key").value = ""; this.changed();
    try { await this.persist(this.snapshot()); this.status("All speech keys removed from this app."); }
    catch { this.status("Keys cleared from memory; saved keys could not be removed. Try Clear all keys again."); }
    finally { this.saving = false; }
  }
}
