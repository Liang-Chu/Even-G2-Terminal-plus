import { MAX_AUDIO_BYTES, transcribe, type VoiceConfig } from "./transcribe.js";

export interface VoiceTarget { key: string; connection: string }
export interface VoiceView { phase: "idle" | "starting" | "recording" | "transcribing" | "review" | "sending" | "error"; text: string; hint: string; sentenceCount?: number; background?: boolean }
interface Dependencies {
  config: () => VoiceConfig;
  target: () => VoiceTarget | undefined;
  mic: (open: boolean) => Promise<boolean>;
  view: (view: VoiceView) => void;
  send: (text: string, target: VoiceTarget) => Promise<void>;
  transcribe?: typeof transcribe;
}
interface Sentence { text: string; pending: boolean; abort: AbortController; error?: string }

export const DELETE_REPEAT_MS = 1000;
/** One draft, ordered tap-to-record segments, then an explicit send to its captured session. */
export class VoiceController {
  private phase: VoiceView["phase"] = "idle";
  private generation = 0;
  private capture = 0;
  private recording?: "starting" | "recording";
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private sentences: Sentence[] = [];
  private target?: VoiceTarget;
  private config?: VoiceConfig;
  private released = false;
  private uncertain = false;
  private finishRequested = false;
  private timer?: ReturnType<typeof setTimeout>;
  private deleteTimer?: ReturnType<typeof setInterval>;
  private micQueue: Promise<unknown> = Promise.resolve();
  constructor(private dependencies: Dependencies) {}
  private show(phase: VoiceView["phase"], text: string, hint: string) {
    this.phase = phase; this.dependencies.view({ phase, text, hint, sentenceCount: this.sentences.length + (this.recording ? 1 : 0), background: this.finishRequested });
  }
  private draft() { return this.sentences.map(sentence => sentence.text).filter(Boolean).join("\n\n"); }
  /** Status/error labels are not a draft; recorded audio awaiting ASR is. */
  hasDraft() { return !!this.draft().trim() || this.bytes > 0 || this.sentences.some(sentence => sentence.pending); }
  private review() {
    const lines = this.sentences.map(sentence => sentence.pending ? sentence.text ? sentence.text + " …" : "Transcribing…" : sentence.error || sentence.text);
    if (this.recording) lines.push(this.recording === "starting" ? "Opening microphone…" : "Listening…");
    const phase = this.recording || (this.sentences.some(s => s.pending) ? "transcribing" : this.sentences.some(s => s.error) ? "error" : "review");
    if (this.finishRequested && phase === "error") {
      this.finishRequested = false;
      this.show(phase, lines.filter(Boolean).join("\n\n"), "Not sent · Delete failed sentence or retry"); return;
    }
    if (this.finishRequested && phase === "review" && !this.draft().trim()) { this.cancel(); return; }
    this.show(phase, lines.filter(Boolean).join("\n\n"), this.recording
      ? this.finishRequested ? "Finishing recording…" : "Tap: stop · Hold: delete · Double: done"
      : this.finishRequested ? "Finishing transcription, then sending…"
        : "Tap: record · Hold: delete · Double: done");
    if (this.finishRequested && phase === "review") void this.confirm();
  }
  private microphone(open: boolean) {
    const result = this.micQueue.then(async () => {
      if (open) return this.dependencies.mic(true);
      let closed = await this.dependencies.mic(false).catch(() => false);
      if (!closed) closed = await this.dependencies.mic(false).catch(() => false);
      return closed;
    });
    this.micQueue = result.catch(() => false); return result;
  }
  private async stopMicrophone() {
    const closed = await this.microphone(false).catch(() => false);
    if (!closed) throw new Error("Microphone stop was not confirmed. Close the Hub app before recording again.");
  }
  private clearAudio() {
    for (const chunk of this.chunks) chunk.fill(0);
    this.chunks = []; this.bytes = 0; this.config = undefined;
  }
  sync() {
    const now = this.dependencies.target();
    if (this.target && (!now || now.key !== this.target.key || now.connection !== this.target.connection)) this.cancel();
  }
  open() {
    if (this.phase !== "idle") return;
    const target = this.dependencies.target();
    if (!target) { this.show("error", "Open a watched session and connect to its terminal first.", "Double tap: done"); return; }
    this.target = { ...target }; this.review();
  }
  async toggleRecording() {
    if (this.finishRequested) return;
    this.stopDeleting();
    if (this.recording) await this.release();
    else await this.press();
  }
  startDeleting() {
    if (this.finishRequested || this.deleteTimer || this.phase === "idle" || this.phase === "sending") return;
    if (this.uncertain) { this.cancel(); return; }
    this.undo();
    this.deleteTimer = setInterval(() => this.undo(), DELETE_REPEAT_MS);
  }
  stopDeleting() { clearInterval(this.deleteTimer); this.deleteTimer = undefined; }
  pause() { this.stopDeleting(); void this.release(); }
  async press() {
    if (this.finishRequested || this.recording || this.phase === "sending") return;
    // A failed send may already have arrived. Starting again must use a new draft.
    if (this.uncertain) this.cancel();
    this.sync();
    const config = this.dependencies.config(), target = this.dependencies.target();
    if (!target) { this.show("error", "Open a watched session and connect to its terminal first.", "Double tap: done"); return; }
    if (!config.key.trim()) { this.show("error", "Add your speech API key in the phone's Voice settings.", "Double tap: done"); return; }
    if (this.sentences.at(-1)?.error) this.sentences.pop();
    if (this.sentences.filter(s => s.pending).length >= 4 || this.sentences.length >= 64) {
      this.show(this.phase, this.draft(), "Wait for transcription, or send/back first"); return;
    }
    const generation = this.generation, capture = ++this.capture;
    this.target ||= { ...target }; this.config = { ...config }; this.released = false;
    this.recording = "starting"; this.review();
    this.timer = setTimeout(() => this.cancel(), 10_000);
    try {
      const opened = await this.microphone(true);
      if (generation !== this.generation || capture !== this.capture) return;
      clearTimeout(this.timer);
      if (!opened) throw new Error("Microphone unavailable. Allow G2 microphone access in Even Hub.");
      this.recording = "recording"; this.review();
      this.timer = setTimeout(() => { void this.release(); }, 60_000);
      if (this.released) await this.release();
    } catch (error) {
      if (generation !== this.generation || capture !== this.capture) return;
      clearTimeout(this.timer); this.recording = undefined; this.clearAudio();
      await this.stopMicrophone().catch(() => {});
      if (generation === this.generation && capture === this.capture) {
        this.finishRequested = false;
        this.show("error", [this.draft(), error instanceof Error ? error.message : "Microphone unavailable."].filter(Boolean).join("\n\n"), "Tap: retry · Double: done");
      }
    }
  }
  audio(chunk: Uint8Array) {
    if (!this.recording || !chunk.length) return;
    const remaining = MAX_AUDIO_BYTES - this.bytes;
    const copy = chunk.slice(0, remaining); this.chunks.push(copy); this.bytes += copy.length;
    if (this.bytes >= MAX_AUDIO_BYTES) void this.release();
  }
  async release() {
    if (this.recording === "starting") { this.released = true; return; }
    if (this.recording !== "recording") return;
    clearTimeout(this.timer);
    const generation = this.generation, config = this.config!;
    const pcm = new Uint8Array(this.bytes - this.bytes % 2);
    let offset = 0;
    for (const chunk of this.chunks) { const part = chunk.subarray(0, pcm.length - offset); pcm.set(part, offset); offset += part.length; }
    this.clearAudio(); this.recording = undefined;
    const sentence: Sentence = { text: "", pending: true, abort: new AbortController() };
    this.sentences.push(sentence); this.review();
    const current = () => generation === this.generation && this.sentences.includes(sentence);
    try {
      await this.stopMicrophone();
      if (!current()) return;
      if (!pcm.length) {
        this.sentences = this.sentences.filter(item => item !== sentence); this.review(); return;
      }
      const text = (await (this.dependencies.transcribe || transcribe)(pcm, config, sentence.abort.signal, undefined, text => {
        if (!current() || !sentence.pending) return;
        const others = this.sentences.filter(s => s !== sentence).reduce((length, s) => length + s.text.length + 2, 0);
        if (others + text.length > 32_000) throw new Error("Draft is too long.");
        sentence.text = text; this.review();
      })).trim();
      if (!current()) return;
      this.sync(); if (!current()) return;
      if (!text) throw new Error("No speech detected. Tap and speak again.");
      if (this.draft().length - sentence.text.length + text.length + 2 * this.sentences.length > 32_000) throw new Error("Draft is too long. Delete the last recording before sending.");
      sentence.text = text; sentence.pending = false; this.review();
    } catch (error) {
      if (current()) { sentence.pending = false; sentence.error = error instanceof Error ? error.message : "Transcription failed."; this.review(); }
    } finally { pcm.fill(0); }
  }
  /** Delete one recording segment, including a pending upload, without leaving editing. */
  undo() {
    if (this.finishRequested || this.phase === "sending") return;
    if (this.uncertain) { this.cancel(); return; }
    if (this.recording) {
      this.capture++; clearTimeout(this.timer); this.recording = undefined; this.clearAudio();
      const generation = this.generation;
      void this.stopMicrophone().catch(error => { if (generation === this.generation) this.show("error", error.message, "Close the Hub app"); });
    } else this.sentences.pop()?.abort.abort();
    this.review();
  }
  edit(text: string) {
    if (this.finishRequested || this.phase !== "review") return;
    // A phone edit replaces the whole draft; keep its blank-line segment boundaries.
    this.sentences = text.slice(0, 32_000).split(/\n\s*\n/).filter(Boolean).map(text => ({ text, pending: false, abort: new AbortController() }));
    this.review();
  }
  /** Confirmed Send & exit finishes the draft, including pending recordings, once. */
  finish() {
    this.sync();
    if (this.phase === "idle" || this.phase === "sending" || this.finishRequested) return;
    this.stopDeleting();
    // An earlier request may have reached the terminal. Returning must never retry it.
    if (this.uncertain) { this.cancel(); return; }
    if (!this.recording && !this.sentences.some(s => s.pending) && !this.draft().trim()) { this.cancel(); return; }
    this.finishRequested = true;
    this.review();
    if (this.recording) void this.release();
  }
  async confirm() {
    this.stopDeleting();
    const text = this.draft().trim();
    if (this.phase !== "review" || !text || !this.target || this.uncertain) return;
    this.sync(); if (!this.target || this.phase !== "review") return;
    const generation = this.generation, target = this.target;
    this.show("sending", text, "Sending…");
    try {
      await this.dependencies.send(text, target);
      if (generation === this.generation) this.cancel();
    } catch {
      if (generation === this.generation) {
        this.uncertain = true; this.finishRequested = false;
        this.show("error", "Send was not confirmed. Check the terminal before sending again.\n\n" + text, "Double tap: done");
      }
    }
  }
  cancel() {
    this.stopDeleting();
    this.generation++; this.capture++; clearTimeout(this.timer);
    const generation = this.generation;
    for (const sentence of this.sentences) sentence.abort.abort();
    if (this.recording) void this.stopMicrophone().catch(error => {
      if (generation === this.generation) this.show("error", error.message, "Close the Hub app");
    });
    this.recording = undefined; this.sentences = []; this.clearAudio(); this.target = undefined; this.uncertain = false; this.finishRequested = false;
    this.show("idle", "", "");
  }
}
