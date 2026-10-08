import test from "node:test";
import assert from "node:assert/strict";
import { pcmWav, transcribe, MAX_AUDIO_BYTES, type VoiceConfig } from "../apps/evenhub/src/voice/transcribe.js";
import { VoiceController, type VoiceTarget, type VoiceView } from "../apps/evenhub/src/voice/controller.js";

const config: VoiceConfig = { provider: "whisper", openaiModel: "whisper-1", key: "fake-key-only-for-tests", language: "zh" };
const tick = () => new Promise(resolve => setImmediate(resolve));
test("phone speech requests contain valid WAV and provider-specific credentials, with no bridge or query-key hop", async () => {
  const pcm = new Uint8Array(16000); pcm[0] = 12;
  const wav = new DataView(await pcmWav(pcm).arrayBuffer());
  assert.equal(wav.getUint32(24, true), 16000); assert.equal(wav.getUint32(40, true), 16000);
  assert.equal(wav.getUint16(22, true), 1); assert.equal(wav.getUint8(44), 12);
  for (const provider of ["whisper", "elevenlabs"] as const) {
    const fetcher: typeof fetch = async (url, options) => {
      assert.equal(url, provider === "whisper" ? "https://api.openai.com/v1/audio/transcriptions" : "https://api.elevenlabs.io/v1/speech-to-text");
      const headers = new Headers(options?.headers), body = options?.body as FormData;
      assert.equal(headers.get(provider === "whisper" ? "authorization" : "xi-api-key"), provider === "whisper" ? `Bearer ${config.key}` : config.key);
      assert.equal(headers.has("Content-Type"), false); assert.equal(options?.credentials, "omit"); assert.equal(options?.redirect, "error");
      assert.equal(body.get(provider === "whisper" ? "model" : "model_id"), provider === "whisper" ? "whisper-1" : "scribe_v2");
      assert.equal(body.get(provider === "whisper" ? "language" : "language_code"), "zh");
      assert.equal((body.get("file") as File).name, "reply.wav");
      assert.ok(![...body.values()].includes(config.key));
      return Response.json({ text: " 修复这个问题 " });
    };
    assert.equal(await transcribe(pcm, { ...config, provider }, new AbortController().signal, fetcher), "修复这个问题");
  }
});

test("speech errors hide provider payloads and malformed/oversized audio is rejected before upload", async () => {
  await assert.rejects(transcribe(new Uint8Array(16000), config, new AbortController().signal,
    async () => new Response(config.key, { status: 401 })), error => error instanceof Error && !error.message.includes(config.key) && /rejected the key/.test(error.message));
  await assert.rejects(transcribe(new Uint8Array(MAX_AUDIO_BYTES + 2), config, new AbortController().signal, async () => { throw new Error("must not send"); }), /Invalid recording/);
  await assert.rejects(transcribe(new Uint8Array(6400), config, new AbortController().signal, async () => Response.json({ text: " " })), /No speech/);
});

test("record/stop transcribes once and explicit confirmation sends once to the captured session", async t => {
  const mic: boolean[] = []; let calls = 0, sent = 0, view: VoiceView | undefined;
  const controller = new VoiceController({ config: () => config, target: () => ({ key: "a", connection: "bridge" }),
    mic: async open => { mic.push(open); return true; }, view: value => { view = value; },
    transcribe: async pcm => { calls++; assert.equal(pcm.length, 16000); return "你好 Pi"; },
    send: async (text, target) => { assert.equal(text, "你好 Pi"); assert.equal(target.key, "a"); sent++; await tick(); } });
  t.after(() => controller.cancel());
  await controller.press(); controller.audio(new Uint8Array(16000)); await controller.release(); await controller.release();
  assert.equal(calls, 1); assert.equal(sent, 0); assert.equal(view?.phase, "review"); assert.deepEqual(mic, [true, false]);
  const sending = controller.confirm(); await controller.confirm(); await sending;
  assert.equal(sent, 1); assert.equal(view?.phase, "idle");
});

test("release during mic startup, cancellation, late cloud results and session changes never leak a send", async t => {
  let enable!: (value: boolean) => void, finish!: (value: string) => void, view: VoiceView | undefined, sent = 0;
  let target: VoiceTarget | undefined = { key: "a", connection: "bridge" };
  const mic: boolean[] = [];
  const controller = new VoiceController({ config: () => config, target: () => target,
    mic: open => { mic.push(open); return open ? new Promise(resolve => { enable = resolve; }) : Promise.resolve(true); },
    view: value => { view = value; }, transcribe: () => new Promise(resolve => { finish = resolve; }), send: async () => { sent++; } });
  t.after(() => controller.cancel());
  const starting = controller.press(); await tick(); controller.audio(new Uint8Array(16000)); void controller.release();
  enable(true); await tick(); assert.equal(view?.phase, "transcribing");
  target = { key: "b", connection: "bridge" }; controller.sync(); finish("late text"); await starting;
  assert.equal(view?.phase, "idle"); await controller.confirm(); assert.equal(sent, 0); assert.deepEqual(mic, [true, false]);
  const next = controller.press(); await tick(); controller.cancel(); enable(true); await next; await tick();
  assert.deepEqual(mic, [true, false, true, false]); assert.equal(view?.phase, "idle");
});

test("missing key never opens mic and uncertain send is never retried automatically", async t => {
  let key = "", view: VoiceView | undefined, sent = 0, uploads = 0;
  const controller = new VoiceController({ config: () => ({ ...config, key }), target: () => ({ key: "a", connection: "bridge" }),
    mic: async () => { assert.ok(key); return true; }, view: value => { view = value; },
    transcribe: async () => { uploads++; return "Run this"; }, send: async () => { sent++; throw new Error("unknown"); } });
  t.after(() => controller.cancel()); await controller.press(); assert.equal(view?.phase, "error"); assert.equal(uploads, 0);
  key = config.key; await controller.press(); controller.audio(new Uint8Array(16000)); await controller.release();
  await controller.confirm(); assert.equal(view?.phase, "error"); await controller.confirm(); assert.equal(sent, 1);
});

test("microphone shutdown is acknowledged before uploading and a failed close is retried within the same operation", async t => {
  let closes = 0, uploaded = false, view: VoiceView | undefined;
  const controller = new VoiceController({ config: () => config, target: () => ({ key: "a", connection: "bridge" }),
    mic: async open => open || ++closes === 2, view: value => { view = value; },
    transcribe: async () => { assert.equal(closes, 2); uploaded = true; return "text"; }, send: async () => {} });
  t.after(() => controller.cancel());
  await controller.press(); controller.audio(new Uint8Array(16000)); await controller.release();
  assert.equal(uploaded, true); assert.equal(view?.phase, "review");
});

test("recordings append in order even when cloud results arrive backwards; deletion keeps the earlier draft", async t => {
  const finishes: ((text: string) => void)[] = [], sends: string[] = [], mic: boolean[] = [];
  let view: VoiceView | undefined;
  const controller = new VoiceController({ config: () => config, target: () => ({ key: "a", connection: "bridge" }),
    mic: async open => { mic.push(open); return true; }, view: value => { view = value; },
    transcribe: () => new Promise(resolve => finishes.push(resolve)), send: async text => { sends.push(text); } });
  t.after(() => controller.cancel());
  await controller.press(); controller.audio(new Uint8Array(16000)); const first = controller.release(); await tick();
  await controller.press(); controller.audio(new Uint8Array(16000)); const second = controller.release(); await tick();
  assert.equal(finishes.length, 2); finishes[1]("第二句"); await second;
  assert.equal(view?.phase, "transcribing"); await controller.confirm(); assert.equal(sends.length, 0);
  finishes[0]("第一句"); await first;
  assert.equal(view?.text, "第一句\n\n第二句"); assert.equal(view?.sentenceCount, 2); assert.equal(view?.phase, "review");
  controller.undo(); assert.equal(view?.text, "第一句"); assert.equal(view?.phase, "review");
  await controller.press(); controller.audio(new Uint8Array(16000)); const third = controller.release(); await tick();
  finishes[2]("替换第二句"); await third; await controller.confirm();
  assert.deepEqual(sends, ["第一句\n\n替换第二句"]); assert.equal(view?.phase, "idle");
  assert.deepEqual(mic, [true, false, true, false, true, false]);
});

test("undo/exit abort removed recordings; late transcription cannot resurrect them or send", async t => {
  const finishes: ((text: string) => void)[] = [], signals: AbortSignal[] = [];
  let view: VoiceView | undefined;
  const controller = new VoiceController({ config: () => config, target: () => ({ key: "a", connection: "bridge" }),
    mic: async () => true, view: value => { view = value; },
    transcribe: (_pcm, _config, signal) => { signals.push(signal); return new Promise(resolve => finishes.push(resolve)); },
    send: async () => assert.fail("Cancelled draft must not send") });
  t.after(() => controller.cancel());
  await controller.press(); controller.audio(new Uint8Array(16000)); const first = controller.release(); await tick();
  finishes[0]("Keep this"); await first;
  await controller.press(); controller.audio(new Uint8Array(16000)); const second = controller.release(); await tick();
  controller.undo(); assert.equal(signals[1].aborted, true); finishes[1]("Discard this"); await second;
  assert.equal(view?.text, "Keep this"); controller.undo(); assert.equal(view?.phase, "review"); assert.equal(view?.text, "");
  await controller.confirm();
  await controller.press(); controller.undo(); assert.equal(view?.phase, "review", "deleting the last recording stays in the editor");
});
