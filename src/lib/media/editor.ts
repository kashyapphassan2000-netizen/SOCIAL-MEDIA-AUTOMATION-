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
  /** Full-screen B-roll cutaways over the voice. */
  broll?: { path: string; kind: "video" | "image"; start: number; end: number }[];
  /** Jump-cut punch-ins (seconds), like a human editor zooming on key lines. */
  punchIns?: [number, number][];
  /** Whoosh on every cut. */
  sfx?: boolean;
  /** Words always highlighted in the captions. */
  emphasis?: string[];
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

const between = (iv: [number, number][]) => iv.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join("+");

/** A short, licence-free "whoosh" synthesised from filtered noise (no stock SFX needed). */
async function makeWhoosh(dir: string): Promise<string> {
  const f = path.join(dir, "whoosh.wav");
  if (!fs.existsSync(f)) {
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "anoisesrc=d=0.45:c=pink:a=0.6:r=44100", "-af",
      "highpass=f=500,lowpass=f=7000,afade=t=in:st=0:d=0.18,afade=t=out:st=0.2:d=0.25,volume=0.9", "-ac", "2", f], 30_000);
  }
  return f;
}

/**
 * Branded vertical short: fill-crop to 9:16, punch-in jump cuts, B-roll cutaways, whoosh SFX,
 * karaoke captions with emphasis words, hook banner, watermark, CTA end card, progress bar, -14 LUFS.
 */
export async function renderShort(inp: EditInput, profile: Profile, timeoutMs = 230_000): Promise<EditOutput> {
  const duration = await probeDuration(inp.audioPath);
  const { w, h } = profile;
  const ass = path.join(inp.workDir, `overlay-${profile.name}.ass`);
  fs.writeFileSync(
    ass,
    buildOverlayAss({ words: inp.words, duration, hook: inp.hook, handle: inp.handle, cta: inp.cta, primary: inp.primary, accent: inp.accent, text: inp.text, width: w, height: h, emphasis: inp.emphasis }),
  );
  const out = path.join(inp.workDir, `final-${profile.name}.mp4`);
  const args: string[] = ["-y"];
  let n = 0;
  const add = (...a: string[]) => {
    args.push(...a);
    return n++;
  };
  const iVis = inp.isStill ? add("-loop", "1", "-framerate", "30", "-i", inp.visualPath) : add("-stream_loop", "-1", "-i", inp.visualPath);
  const iAud = add("-i", inp.audioPath);
  const iMus = inp.musicPath ? add("-stream_loop", "-1", "-i", inp.musicPath) : -1;
  const broll = (inp.broll ?? []).filter((b) => b.end > b.start && b.start < duration);
  const iBroll = broll.map((b) =>
    b.kind === "image" ? add("-loop", "1", "-framerate", "30", "-t", (b.end - b.start + 0.2).toFixed(2), "-i", b.path) : add("-t", (b.end - b.start + 0.5).toFixed(2), "-i", b.path),
  );
  const punch = (inp.punchIns ?? []).filter(([a, b]) => b > a);
  const cuts = [...broll.map((b) => b.start), ...punch.map(([a]) => a)].filter((t) => t > 0.3).sort((a, b) => a - b).slice(0, 10);
  const iSfx = inp.sfx && cuts.length ? add("-i", await makeWhoosh(inp.workDir)) : -1;
  const iBar = add("-f", "lavfi", "-i", `color=c=${inp.accent.replace("#", "0x")}:s=${w}x${Math.round(h / 140)}:r=30`);

  const f: string[] = [];
  // Still fallback gets a slow drift so it does not look frozen.
  const base = inp.isStill
    ? `scale=${Math.round(w * 1.1)}:${Math.round(h * 1.1)}:force_original_aspect_ratio=increase,crop=${w}:${h}:x='(iw-ow)/2+sin(t/2.7)*${Math.round(w * 0.03)}':y='(ih-oh)/2+cos(t/3.1)*${Math.round(h * 0.02)}'`
    : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  f.push(`[${iVis}:v]${base},setsar=1,fps=30[v0]`);
  let cur = "v0";
  if (punch.length) {
    f.push(`[${cur}]split[pa][pb]`, `[pb]scale=${Math.round(w * 1.14)}:${Math.round(h * 1.14)},crop=${w}:${h}[pz]`, `[pa][pz]overlay=enable='${between(punch)}'[vp]`);
    cur = "vp";
  }
  broll.forEach((b, k) => {
    const len = (b.end - b.start).toFixed(2);
    const prep =
      b.kind === "image"
        ? `scale=${Math.round(w * 1.08)}:${Math.round(h * 1.08)}:force_original_aspect_ratio=increase,crop=${w}:${h}:x='(iw-ow)/2+t*14':y='(ih-oh)/2'`
        : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30`;
    f.push(`[${iBroll[k]}:v]${prep},setsar=1,trim=duration=${len},setpts=PTS-STARTPTS+${b.start.toFixed(2)}/TB[b${k}]`);
    f.push(`[${cur}][b${k}]overlay=enable='between(t,${b.start.toFixed(2)},${b.end.toFixed(2)})':eof_action=pass[vb${k}]`);
    cur = `vb${k}`;
  });
  f.push(`[${cur}]subtitles='${filterPath(ass)}':fontsdir='${filterPath(fontsDir())}'[v1]`);
  f.push(`[v1][${iBar}:v]overlay=x='-w+w*t/${duration.toFixed(3)}':y=H-h:shortest=1[v]`);

  const norm = profile.loudnorm ? ",loudnorm=I=-14:TP=-1.5:LRA=11" : "";
  const mix: string[] = [];
  f.push(`[${iAud}:a]aresample=44100,aformat=channel_layouts=stereo[voice]`);
  mix.push("[voice]");
  if (iMus >= 0) {
    f.push(`[${iMus}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${inp.musicVolume}[mus]`);
    mix.push("[mus]");
  }
  if (iSfx >= 0) {
    f.push(`[${iSfx}:a]aresample=44100,asplit=${cuts.length}${cuts.map((_, i) => `[s${i}]`).join("")}`);
    cuts.forEach((t, i) => {
      const ms = Math.max(0, Math.round((t - 0.12) * 1000));
      f.push(`[s${i}]adelay=${ms}|${ms},volume=0.35[d${i}]`);
      mix.push(`[d${i}]`);
    });
  }
  f.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0${norm}[a]` : `[voice]anull${norm}[a]`);

  args.push(
    "-filter_complex", f.join(";"),
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

/** Punch in on every other sentence after the hook — the classic talking-head jump-cut rhythm. */
export function planPunchIns(words: WordTiming[], duration: number): [number, number][] {
  const sentences: [number, number][] = [];
  let start = words[0]?.start ?? 0;
  for (let i = 0; i < words.length; i++) {
    if (/[.!?।]$/.test(words[i].word) || i === words.length - 1) {
      sentences.push([start, words[i].end]);
      start = words[i + 1]?.start ?? words[i].end;
    }
  }
  return sentences.filter((_, i) => i % 2 === 1).map(([a, b]) => [a, Math.min(b, duration - 2.6)] as [number, number]).filter(([a, b]) => b - a > 0.8);
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
