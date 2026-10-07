import fs from "node:fs";
import path from "node:path";
import { getAssets, getSettings, saveAssets, saveSettings } from "./db";
import { getStorage } from "./storage";
import { extractVoice, hasVideoStream, probeDuration, rmrf, runFfmpeg, tmpDir } from "./media/ffmpeg";
import { elevenCreateVoice } from "./ai/voice";
import type { Assets } from "./types";

/** New base photo => cached outfit looks are stale. */
export async function setPhoto(url: string, by: string): Promise<Assets> {
  const a = { ...(await getAssets()), photoUrl: url, updatedAt: new Date().toISOString(), updatedBy: by };
  await saveAssets(a);
  const s = await getSettings();
  await saveSettings({ ...s, looks: s.looks.map(({ imageUrl: _drop, ...l }) => l) });
  return a;
}

/**
 * Voice clip (video or audio) -> clean mono sample (<=120s, for ElevenLabs instant cloning)
 * + a 10s reference (for zero-shot F5-TTS) + a still frame as photo if none exists yet.
 */
export async function setVoiceClip(url: string, by: string): Promise<{ assets: Assets; notes: string[] }> {
  const storage = getStorage();
  const notes: string[] = [];
  const dir = tmpDir();
  try {
    const src = path.join(dir, "clip.bin");
    fs.writeFileSync(src, await storage.read(url));
    const full = path.join(dir, "sample.mp3");
    await extractVoice(src, full, 120);
    const secs = await probeDuration(full);
    if (secs < 8) throw new Error(`Voice clip is only ${secs.toFixed(1)}s — record at least 30-60s of clear speech`);
    if (secs < 30) notes.push(`Clip is ${secs.toFixed(0)}s. 60-120s of clean speech gives a much better clone.`);
    const short = path.join(dir, "ref.mp3");
    await runFfmpeg(["-y", "-ss", secs > 14 ? "1" : "0", "-i", full, "-t", "10", "-c", "copy", short]);
    const a: Assets = { ...(await getAssets()), clipUrl: url, updatedAt: new Date().toISOString(), updatedBy: by };
    a.voiceSampleUrl = await storage.put("assets/voice-sample.mp3", fs.readFileSync(full), "audio/mpeg");
    a.voiceRefShortUrl = await storage.put("assets/voice-ref.mp3", fs.readFileSync(short), "audio/mpeg");
    a.elevenVoiceId = undefined;
    if (await hasVideoStream(src)) {
      // A video of you talking doubles as the first "performance clip" for natural lip-sync.
      const clips = (a.clips ?? []).filter((c) => c.name !== "voice clip");
      a.clips = [{ url, name: "voice clip", addedAt: new Date().toISOString() }, ...clips];
    }
    if (!a.photoUrl) {
      const still = path.join(dir, "frame.jpg");
      try {
        await runFfmpeg(["-y", "-ss", "1", "-i", src, "-frames:v", "1", "-q:v", "2", still]);
        a.photoUrl = await storage.put("assets/photo-from-clip.jpg", fs.readFileSync(still), "image/jpeg");
        notes.push("No photo uploaded yet — grabbed a frame from your clip. Upload a proper high-res photo for best results.");
      } catch {
        /* audio-only clip */
      }
    }
    if (process.env.ELEVENLABS_API_KEY && !process.env.ELEVENLABS_VOICE_ID) {
      try {
        a.elevenVoiceId = await elevenCreateVoice(fs.readFileSync(full), `Shorts voice ${new Date().toISOString().slice(0, 10)}`);
        notes.push("ElevenLabs voice clone created.");
      } catch (e) {
        notes.push(`ElevenLabs clone failed (will retry on first video): ${(e as Error).message.slice(0, 200)}`);
      }
    }
    await saveAssets(a);
    return { assets: a, notes };
  } finally {
    rmrf(dir);
  }
}

/**
 * Performance clip = 10-60 s of you talking naturally on camera (any words, natural hand gestures,
 * vertical, face clearly visible, steady framing). Each clip is a brand "look" for real-footage lip-sync.
 */
export async function addPerformanceClip(url: string, name: string, by: string): Promise<{ assets: Assets; notes: string[] }> {
  const storage = getStorage();
  const dir = tmpDir();
  const notes: string[] = [];
  try {
    const src = path.join(dir, "clip.bin");
    fs.writeFileSync(src, await storage.read(url));
    if (!(await hasVideoStream(src))) throw new Error("That file has no video track");
    const secs = await probeDuration(src);
    if (secs < 5) throw new Error(`Clip is only ${secs.toFixed(1)}s — record 10-60 s of natural talking`);
    if (secs > 120) notes.push("Only the first 15 s are used as the motion loop; shorter clips upload faster.");
    const a = await getAssets();
    a.clips = [...(a.clips ?? []).filter((c) => c.url !== url), { url, name: name || `clip ${(a.clips?.length ?? 0) + 1}`, addedAt: new Date().toISOString() }];
    a.updatedAt = new Date().toISOString();
    a.updatedBy = by;
    await saveAssets(a);
    notes.push(`Clip saved — ${a.clips.length} look(s) in rotation.`);
    return { assets: a, notes };
  } finally {
    rmrf(dir);
  }
}

export async function removeClip(url: string): Promise<Assets> {
  const a = await getAssets();
  a.clips = (a.clips ?? []).filter((c) => c.url !== url);
  await saveAssets(a);
  await getStorage().del([url]).catch(() => undefined);
  return a;
}
