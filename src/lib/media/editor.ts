import fs from "node:fs";
import path from "node:path";
import { buildOverlayAss, buildThumbnailAss } from "./captions";
import { fontsDir, probeDuration, runFfmpeg } from "./ffmpeg";
import type { WordTiming } from "../types";

export interface EditInput {
  workDir: string;
  /** Talking-head video (any aspect) — or a still image when isStill = true. */
  visualPath: string;
  isStill: boolean;
  audioPath: string;
  musicPath?: string;
  musicVolume: number;
  words: WordTiming[];
  hook: string;
  handle: string;
  cta: string;
  primary: string;
  accent: string;
  text: string;
  thumbnailText: string;
}

export interface EditOutput {
  videoPath: string;
  thumbPath: string;
  duration: number;
  mode: string;
}

const filterPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

interface Profile {
  name: string;
  w: number;
  h: number;
  preset: string;
  crf: number;
  loudnorm: boolean;
}

export const PROFILES: Profile[] = [
  { name: "full-1080p", w: 1080, h: 1920, preset: "veryfast", crf: 21, loudnorm: true },
  { name: "light-720p", w: 720, h: 1280, preset: "ultrafast", crf: 23, loudnorm: false },
];

/** Branded vertical short: fill-crop to 9:16, karaoke captions, hook banner, watermark, CTA end card, progress bar, loudness normalised. */
export async function renderShort(inp: EditInput, profile: Profile, timeoutMs = 230_000): Promise<EditOutput> {
  const duration = await probeDuration(inp.audioPath);
  const { w, h } = profile;
  const ass = path.join(inp.workDir, `overlay-${profile.name}.ass`);
  fs.writeFileSync(
    ass,
    buildOverlayAss({ words: inp.words, duration, hook: inp.hook, handle: inp.handle, cta: inp.cta, primary: inp.primary, accent: inp.accent, text: inp.text, width: w, height: h }),
  );
  const out = path.join(inp.workDir, `final-${profile.name}.mp4`);
  const args: string[] = ["-y"];
  if (inp.isStill) args.push("-loop", "1", "-framerate", "30", "-i", inp.visualPath);
  else args.push("-stream_loop", "-1", "-i", inp.visualPath);
  args.push("-i", inp.audioPath);
  if (inp.musicPath) args.push("-stream_loop", "-1", "-i", inp.musicPath);
  args.push("-f", "lavfi", "-i", `color=c=${inp.accent.replace("#", "0x")}:s=${w}x${Math.round(h / 140)}:r=30`);
  const barIdx = inp.musicPath ? 3 : 2;

  // Still fallback gets a slow drift so it does not look frozen.
  const base = inp.isStill
    ? `scale=${Math.round(w * 1.1)}:${Math.round(h * 1.1)}:force_original_aspect_ratio=increase,crop=${w}:${h}:x='(iw-ow)/2+sin(t/2.7)*${Math.round(w * 0.03)}':y='(ih-oh)/2+cos(t/3.1)*${Math.round(h * 0.02)}'`
    : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  const v = `[0:v]${base},setsar=1,fps=30,subtitles='${filterPath(ass)}':fontsdir='${filterPath(fontsDir())}'[v1];[v1][${barIdx}:v]overlay=x='-w+w*t/${duration.toFixed(3)}':y=H-h:shortest=1[v]`;
  const norm = profile.loudnorm ? ",loudnorm=I=-14:TP=-1.5:LRA=11" : "";
  const a = inp.musicPath
    ? `[1:a]aresample=44100,volume=1.0[voice];[2:a]aresample=44100,volume=${inp.musicVolume}[m];[voice][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0${norm}[a]`
    : `[1:a]aresample=44100${norm}[a]`;
  args.push(
    "-filter_complex", `${v};${a}`,
    "-map", "[v]", "-map", "[a]",
    "-t", duration.toFixed(3),
    "-c:v", "libx264", "-preset", profile.preset, "-crf", String(profile.crf), "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
    "-movflags", "+faststart",
    out,
  );
  await runFfmpeg(args, timeoutMs);
  const thumbPath = await renderThumbnail(inp, w, h);
  return { videoPath: out, thumbPath, duration, mode: profile.name };
}

export async function renderThumbnail(inp: EditInput, w = 1080, h = 1920): Promise<string> {
  const ass = path.join(inp.workDir, "thumb.ass");
  fs.writeFileSync(ass, buildThumbnailAss(inp.thumbnailText || inp.hook, inp.handle, inp.primary, inp.accent, w, h));
  const out = path.join(inp.workDir, "thumb.jpg");
  const input = inp.isStill ? ["-i", inp.visualPath] : ["-ss", "1.2", "-i", inp.visualPath];
  await runFfmpeg([
    "-y", ...input,
    "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,eq=brightness=-0.04:saturation=1.15,subtitles='${filterPath(ass)}':fontsdir='${filterPath(fontsDir())}'`,
    "-frames:v", "1", "-q:v", "3", out,
  ], 60_000);
  return out;
}
