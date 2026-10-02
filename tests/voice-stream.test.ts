import test from "node:test";
import assert from "node:assert/strict";
import { transcribe, type VoiceConfig } from "../apps/evenhub/src/voice/transcribe.js";
import { VoiceController, type VoiceTarget, type VoiceView } from "../apps/evenhub/src/voice/controller.js";

const config: VoiceConfig = { provider: "whisper", openaiModel: "gpt-transcribe", key: "synthetic-key", language: "zh" };
const pcm = () => new Uint8Array(16000);
const tick = () => new Promise(resolve => setImmediate(resolve));
function stream() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    push: (text: string) => out.enqueue(new TextEncoder().encode(text)), close: () => out.close(),
    event: (event: unknown) => out.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`)) };
}

test("OpenAI streaming displays partial text before done and uses model-specific multipart language hints", async () => {
  const s = stream(), partials: string[] = [];
  const pending = transcribe(pcm(), config, new AbortController().signal, async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    const data = init?.body as FormData;
    assert.equal(data.get("model"), "gpt-transcribe"); assert.equal(data.get("stream"), "true");
    assert.equal(data.get("languages[]"), "zh"); assert.equal(data.has("language"), false);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-key");
    return s.response;
  }, text => partials.push(text));
  s.push('data: {"type":"transcript.text.delta","delta":"第一');
  s.push('句"}\r\n\r\n'); await tick(); assert.deepEqual(partials, ["第一句"]);
  s.event({ type: "transcript.text.delta", delta: "。" }); await tick(); assert.equal(partials.at(-1), "第一句。");
  s.event({ type: "transcript.text.done", text: "第一句。" }); assert.equal(await pending, "第一句。");
});

test("truncated, malformed and oversized streams fail without leaking provider payload or accepting partial text", async () => {
  for (const data of [
    'data: {"type":"transcript.text.delta","delta":"Unfinished"}\n\n',
    'data: {"type":"error","message":"synthetic-key"}\n\n',
    `data: ${JSON.stringify({ type: "transcript.text.delta", delta: "x".repeat(32_001) })}\n\n`,
    'data: not-json synthetic-key\n\n',
  ]) {
    const s = stream(); s.push(data); s.close();
    await assert.rejects(transcribe(pcm(), config, new AbortController().signal, async () => s.response),
      error => error instanceof Error && !error.message.includes("synthetic-key") && /unreadable/.test(error.message));
  }
});

test("abort cancels a pending stream read and deleted partial sentences never reappear or send", async t => {
  const s = stream(), abort = new AbortController();
  const p = transcribe(pcm(), config, abort.signal, async () => s.response);
  await tick(); abort.abort(); await assert.rejects(p, /cancelled/);
  let view: VoiceView | undefined, partial!: (text: string) => void, finish!: (text: string) => void, signal!: AbortSignal;
  const voice = new VoiceController({ config: () => config, target: () => ({ key: "a", connection: "bridge" }),
    mic: async () => true, view: value => { view = value; }, send: async () => assert.fail("Partial or deleted text must not send"),
    transcribe: (_pcm, _config, received, _request, update) => { signal = received; partial = update!; return new Promise(r => { finish = r; }); } });
  t.after(() => voice.cancel()); voice.open(); await voice.toggleRecording(); voice.audio(pcm()); const recording = voice.toggleRecording(); await tick();
  partial("Partial sentence"); assert.equal(view?.phase, "transcribing"); assert.match(view!.text, /Partial sentence/); await voice.confirm();
  voice.undo(); assert.equal(signal.aborted, true); assert.equal(view?.text, "");
  partial("Late partial"); finish("Late completion"); await recording; assert.equal(view?.text, ""); await voice.confirm();
});

test("menu pause, cancellation and target loss stop held deletion; mic startup can be stopped with a second tap", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let view: VoiceView | undefined, target: VoiceTarget | undefined = { key: "a", connection: "bridge" };
  const mic: boolean[] = [];
  const voice = new VoiceController({ config: () => config, target: () => target, view: value => { view = value; },
    mic: async open => { mic.push(open); return true; }, send: async () => {}, transcribe: async () => "First" });
  t.after(() => voice.cancel()); voice.open();
  const started = voice.toggleRecording(); await voice.toggleRecording(); voice.audio(pcm()); await started;
  assert.deepEqual(mic, [true, false]); assert.equal(view?.phase, "review");
  voice.edit("First\n\nSecond\n\nThird"); voice.startDeleting(); assert.equal(view?.text, "First\n\nSecond");
  voice.pause(); t.mock.timers.tick(3000); assert.equal(view?.text, "First\n\nSecond");
  voice.startDeleting(); target = undefined; voice.sync(); t.mock.timers.tick(3000);
  assert.equal(view?.phase, "idle"); assert.equal(view?.text, "");
});
