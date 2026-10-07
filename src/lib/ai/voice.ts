import { download, http, httpJson } from "../http";
import { falAvailable, falRun } from "./fal";
import { wordsFromCharAlignment } from "../media/captions";
import type { Assets, WordTiming } from "../types";

export interface VoiceResult {
  audio: Buffer;
  ext: "mp3" | "wav";
  contentType: string;
  /** Exact word timings when the provider returns alignment; otherwise estimated later. */
  words?: WordTiming[];
}

export interface VoiceContext {
  assets: Assets;
  /** Persist a newly created cloned-voice id. */
  saveVoiceId(id: string): Promise<void>;
  readSample(url: string): Promise<Buffer>;
}

export interface VoiceProvider {
  name: string;
  /** Is this provider usable right now (keys + reference audio present)? */
  available(a: Assets): boolean;
  /** true = sounds like the creator; false = generic stock voice. */
  cloned: boolean;
  synthesize(text: string, ctx: VoiceContext): Promise<VoiceResult>;
}

const EL = "https://api.elevenlabs.io/v1";

export async function elevenCreateVoice(sample: Buffer, name: string): Promise<string> {
  const fd = new FormData();
  fd.set("name", name);
  fd.set("description", "Creator voice for automated shorts");
  fd.set("remove_background_noise", "true");
  fd.append("files", new Blob([new Uint8Array(sample)], { type: "audio/mpeg" }), "sample.mp3");
  const r = await httpJson<{ voice_id: string }>(`${EL}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
    body: fd,
    timeoutMs: 120_000,
    retries: 1,
  });
  return r.voice_id;
}

const elevenlabs: VoiceProvider = {
  name: "elevenlabs",
  cloned: true,
  available: (a) => !!process.env.ELEVENLABS_API_KEY && !!(process.env.ELEVENLABS_VOICE_ID || a.elevenVoiceId || a.voiceSampleUrl),
  async synthesize(text, ctx) {
    let voiceId = process.env.ELEVENLABS_VOICE_ID || ctx.assets.elevenVoiceId;
    if (!voiceId) {
      voiceId = await elevenCreateVoice(await ctx.readSample(ctx.assets.voiceSampleUrl!), `Shorts voice ${new Date().toISOString().slice(0, 10)}`);
      await ctx.saveVoiceId(voiceId);
    }
    const r = await httpJson<{
      audio_base64: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    }>(`${EL}/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
        voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true, speed: 1.05 },
      }),
      timeoutMs: 120_000,
    });
    const al = r.alignment;
    return {
      audio: Buffer.from(r.audio_base64, "base64"),
      ext: "mp3",
      contentType: "audio/mpeg",
      words: al ? wordsFromCharAlignment(al.characters, al.character_start_times_seconds, al.character_end_times_seconds) : undefined,
    };
  },
};

/** Zero-shot clone from a ~10s reference — no training step, works when ElevenLabs is down or out of credits. */
const falF5: VoiceProvider = {
  name: "fal-f5",
  cloned: true,
  available: (a) => falAvailable() && !!(a.voiceRefShortUrl || a.voiceSampleUrl),
  async synthesize(text, ctx) {
    const r = await falRun<{ audio_url: { url: string; content_type?: string } }>(process.env.FAL_TTS_MODEL || "fal-ai/f5-tts", {
      gen_text: text,
      ref_audio_url: ctx.assets.voiceRefShortUrl || ctx.assets.voiceSampleUrl,
      ...(ctx.assets.voiceSampleText ? { ref_text: ctx.assets.voiceSampleText } : {}),
      model_type: "F5-TTS",
      remove_silence: true,
    });
    return { audio: await download(r.audio_url.url), ext: "wav", contentType: r.audio_url.content_type || "audio/wav" };
  },
};

/** Generic stock voice — only used when the owner explicitly allows it (brand risk: not your voice). */
const openaiTts: VoiceProvider = {
  name: "openai-tts",
  cloned: false,
  available: () => !!process.env.OPENAI_API_KEY,
  async synthesize(text) {
    const res = await http("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: process.env.OPENAI_TTS_VOICE || "onyx", input: text, response_format: "mp3" }),
      timeoutMs: 120_000,
    });
    return { audio: Buffer.from(await res.arrayBuffer()), ext: "mp3", contentType: "audio/mpeg" };
  },
};

export const VOICE_REGISTRY: Record<string, VoiceProvider> = { elevenlabs, "fal-f5": falF5, "openai-tts": openaiTts };
