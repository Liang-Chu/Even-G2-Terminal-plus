import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSettings } from "../apps/evenhub/src/voice/settings.js";

test("saved voice configuration loads before its settings DOM is requested", async () => {
  // No document exists in Node: mounting the dialog during startup would fail.
  const settings = new VoiceSettings(() => {});
  await settings.attachBridge({ getLocalStorage: async () => JSON.stringify({
    provider: "whisper", language: "zh", openaiModel: "gpt-transcribe", keys: { whisper: "fixture-key" },
  }), setLocalStorage: async () => true });
  assert.deepEqual(settings.config(), { provider: "whisper", language: "zh", openaiModel: "gpt-transcribe", key: "fixture-key" });
});
