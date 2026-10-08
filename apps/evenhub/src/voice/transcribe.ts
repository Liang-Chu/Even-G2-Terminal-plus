import { transcriptStream } from "./transcript-stream.js";
export type VoiceProvider = "whisper" | "elevenlabs";
export interface VoiceConfig { provider: VoiceProvider; key: string; language: "" | "zh" | "en"; openaiModel?: "whisper-1" | "gpt-transcribe" }
export const DEFAULT_OPENAI_MODEL = "gpt-transcribe";
export const MAX_AUDIO_BYTES = 16_000 * 2 * 60;
class SpeechError extends Error {}

/** G2 provides PCM s16le, 16 kHz, mono. Whisper requires a file with format metadata. */
export function pcmWav(pcm: Uint8Array): Blob {
  if (!pcm.length || pcm.length % 2 || pcm.length > MAX_AUDIO_BYTES) throw new Error("Invalid recording length");
  const bytes = new Uint8Array(44 + pcm.length), view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => [...text].forEach((char, i) => bytes[offset + i] = char.charCodeAt(0));
  tag(0, "RIFF"); view.setUint32(4, 36 + pcm.length, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, pcm.length, true); bytes.set(pcm, 44);
  return new Blob([bytes], { type: "audio/wav" });
}

/** Direct phone → provider request. Never proxy audio or credentials through the Windows bridge. */
export async function transcribe(pcm: Uint8Array, config: VoiceConfig, signal: AbortSignal, request: typeof fetch = fetch, partial?: (text: string) => void): Promise<string> {
  if (!["whisper", "elevenlabs"].includes(config.provider)) throw new Error("Choose a speech provider in Voice settings.");
  if (!config.key.trim() || /[\r\n]/.test(config.key)) throw new Error("Enter your API key in Voice settings.");
  if (pcm.length < 6400) throw new Error("Recording too short. Tap and speak again.");
  const file = pcmWav(pcm), body = new FormData();
  body.set("file", file, "reply.wav");
  const whisper = config.provider === "whisper";
  const model = config.openaiModel || DEFAULT_OPENAI_MODEL, streaming = whisper && model === "gpt-transcribe";
  if (whisper && !["whisper-1", "gpt-transcribe"].includes(model)) throw new Error("Choose a supported speech model in Voice settings.");
  body.set(whisper ? "model" : "model_id", whisper ? model : "scribe_v2");
  if (config.language) body.set(whisper ? streaming ? "languages[]" : "language" : "language_code", config.language);
  if (whisper) body.set("response_format", "json");
  else { body.set("tag_audio_events", "false"); body.set("diarize", "false"); body.set("timestamps_granularity", "none"); }
  if (streaming) body.set("stream", "true");
  const timeout = new AbortController();
  const abort = () => timeout.abort(); signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 45_000);
  try {
    const response = await request(whisper ? "https://api.openai.com/v1/audio/transcriptions" : "https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST", headers: whisper ? { Authorization: `Bearer ${config.key.trim()}` } : { "xi-api-key": config.key.trim() },
      body, signal: timeout.signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      // Provider response bodies can echo credentials or audio; show only safe, actionable errors.
      if ([401, 403].includes(response.status)) throw new SpeechError("Speech service rejected the key. Check Voice settings and key permissions.");
      if (response.status === 429) throw new SpeechError("Speech service quota or rate limit reached. Check your account and try later.");
      throw new SpeechError(`Speech service returned HTTP ${response.status}. Try again later.`);
    }
    const data = streaming && response.headers.get("content-type")?.includes("text/event-stream")
      ? { text: await transcriptStream(response, timeout.signal, partial) } : await response.json() as { text?: unknown };
    if (typeof data.text !== "string" || !data.text.trim()) throw new SpeechError("No speech recognized. Tap and speak again.");
    if (data.text.length > 32_000) throw new SpeechError("Transcript is too long. Record a shorter prompt.");
    return data.text.trim();
  } catch (error) {
    if (timeout.signal.aborted) throw new Error(signal.aborted ? "Transcription cancelled." : "Transcription timed out. Tap to try again.");
    if (error instanceof TypeError) throw new Error("Cannot reach speech service from this phone. Check internet access and try again.");
    if (error instanceof SpeechError) throw error;
    throw new Error("Speech service returned an unreadable response. Try again later.");
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
