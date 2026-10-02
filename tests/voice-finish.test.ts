import test from "node:test";
import assert from "node:assert/strict";
import { VoiceController, type VoiceTarget, type VoiceView } from "../apps/evenhub/src/voice/controller.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let view: VoiceView | undefined, target: VoiceTarget | undefined = { key: "current", connection: "bridge" }, sendFails = false;
  const sends: string[] = [], mic: boolean[] = [], completions: { resolve: (s: string) => void; reject: (e: Error) => void; signal: AbortSignal }[] = [];
  const voice = new VoiceController({ config: () => ({ provider: "whisper", key: "synthetic-test-key", language: "" }), target: () => target,
    view: value => { view = value; }, mic: async open => { mic.push(open); return true; },
    transcribe: (_pcm, _config, signal) => new Promise((resolve, reject) => completions.push({ resolve, reject, signal })),
    send: async (text, scope) => { assert.equal(scope.key, "current"); sends.push(text); if (sendFails) throw new Error("Unconfirmed"); } });
  return { voice, sends, mic, completions, view: () => view!, failSend: () => { sendFails = true; },
    disconnect: () => { target = undefined; voice.sync(); },
    record: async (text: string) => {
      await voice.press(); voice.audio(new Uint8Array(16000)); const p = voice.release(); await tick(); completions.at(-1)!.resolve(text); await p;
    } };
}

test("finish sends a completed nonempty draft once and returns; whitespace sends nothing", async t => {
  const f = fixture(); t.after(() => f.voice.cancel()); f.voice.open(); f.voice.edit(" \n  "); f.voice.finish();
  assert.equal(f.view().phase, "idle"); assert.deepEqual(f.sends, []);
  await f.record("First sentence"); await f.record("Second sentence");
  f.voice.finish(); assert.equal(f.view().background, true); f.voice.finish(); await tick();
  assert.deepEqual(f.sends, ["First sentence\n\nSecond sentence"]); assert.equal(f.view().phase, "idle");
});

test("finish returns immediately, stops recording and waits for every sentence in order before one send", async t => {
  const f = fixture(); t.after(() => f.voice.cancel());
  await f.voice.press(); f.voice.audio(new Uint8Array(16000)); const first = f.voice.release(); await tick();
  await f.voice.press(); f.voice.audio(new Uint8Array(16000));
  f.voice.finish(); f.voice.finish(); assert.equal(f.view().background, true); await tick();
  assert.deepEqual(f.mic, [true, false, true, false]); assert.equal(f.completions.length, 2);
  f.completions[1].resolve("Second"); await tick(); assert.equal(f.view().phase, "transcribing"); assert.deepEqual(f.sends, []);
  f.completions[0].resolve("First"); await first; await tick();
  assert.deepEqual(f.sends, ["First\n\nSecond"]); assert.equal(f.view().phase, "idle");
});

test("finish during microphone startup stops it once ready and sends the captured sentence", async t => {
  let enable!: (value: boolean) => void; const sends: string[] = [], mic: boolean[] = [];
  const voice = new VoiceController({ config: () => ({ provider: "whisper", key: "synthetic", language: "" }),
    target: () => ({ key: "a", connection: "bridge" }), view: () => {},
    mic: open => { mic.push(open); return open ? new Promise(resolve => { enable = resolve; }) : Promise.resolve(true); },
    transcribe: async () => "Final sentence", send: async text => { sends.push(text); } });
  t.after(() => voice.cancel()); const starting = voice.press(); await tick(); voice.audio(new Uint8Array(16000));
  voice.finish(); enable(true); await starting; await tick();
  assert.deepEqual(mic, [true, false]); assert.deepEqual(sends, ["Final sentence"]);
});

test("cancel or disconnect revokes a pending finish and late transcription cannot send", async t => {
  for (const stop of ["cancel", "disconnect"] as const) {
    const f = fixture(); t.after(() => f.voice.cancel());
    await f.voice.press(); f.voice.audio(new Uint8Array(16000)); f.voice.finish(); await tick();
    if (stop === "cancel") f.voice.cancel(); else f.disconnect();
    assert.equal(f.completions[0].signal.aborted, true); f.completions[0].resolve("Late text"); await tick();
    assert.deepEqual(f.sends, []); assert.equal(f.view().phase, "idle");
  }
});

test("failed transcription returns to editing without sending a partial draft; uncertain delivery is never retried", async t => {
  const f = fixture(); t.after(() => f.voice.cancel()); await f.record("Keep this");
  await f.voice.press(); f.voice.audio(new Uint8Array(16000)); f.voice.finish(); await tick();
  f.completions.at(-1)!.reject(new Error("Transcription failed")); await tick();
  assert.equal(f.view().phase, "error"); assert.equal(f.view().background, false); assert.deepEqual(f.sends, []);
  f.voice.finish(); await tick(); assert.deepEqual(f.sends, []);
  f.voice.undo(); f.failSend(); f.voice.finish(); await tick();
  assert.deepEqual(f.sends, ["Keep this"]); assert.equal(f.view().phase, "error");
  f.voice.finish(); await tick(); assert.deepEqual(f.sends, ["Keep this"]); assert.equal(f.view().phase, "idle");
});
