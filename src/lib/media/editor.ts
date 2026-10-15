import fs from "node:fs";
import path from "node:path";
import { buildOverlayAss, buildThumbnailAss } from "./captions";
import { filterPath, fontsDir, probeDuration, runFfmpeg } from "./ffmpeg";
import type { WordTiming } from "../types";

export interface EditInput {
  workDir: string;
  /** Talking-head video (any aspect) — or a still image when isStill = true. */
  visualPath: string;
  isStill: boolean;
  audioPath: string;
  musicPath?: string;
  musicVolume: number;
  /** Clean the voice (noise reduction + compression). Default on. */
  denoise?: boolean;
  /** pip: explainer visuals full-frame + your face in a rounded box bottom-right. face: classic talking head. */
  layout?: "pip" | "face";
  /** pip: on-screen key point per scene. */
  scenes?: { start: number; end: number; point: string; visual?: boolean }[];
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
/** Face box for the explainer layout: bottom-right, kept clear of the platforms' like/comment buttons and caption area. */
export function pipGeometry(w: number, h: number) {
  const k = w / 1080;
  const even = (n: number) => Math.round(n / 2) * 2;
  const bw = even(470 * k);
  const bh = even(560 * k);
  return { w: bw, h: bh, x: even(w - bw - 120 * k), y: even(h - bh - 330 * k), r: Math.round(40 * k), b: Math.max(2, Math.round(7 * k)) };
}

const hex = (c: string) => `0x${c.replace("#", "").slice(0, 6).padStart(6, "0")}`;
/** Darken (f < 1) a #rrggbb colour. */
function shade(c: string, f: number) {
  const n = parseInt(c.replace("#", "").slice(0, 6).padStart(6, "0"), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, "0")).join("")}`;
}

/** White-on-black rounded-rectangle mask (PNG) used as an alpha channel. */
async function roundedMask(dir: string, name: string, w: number, h: number, r: number): Promise<string> {
  const out = path.join(dir, `${name}.png`);
  if (fs.existsSync(out)) return out;
  const expr = `255*lte(hypot(max(0,abs(X-${w / 2})-${w / 2 - r}),max(0,abs(Y-${h / 2})-${h / 2 - r})),${r})`;
  await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:d=0.04`, "-vf", `format=gray,geq=lum='${expr}'`, "-frames:v", "1", out], 30_000);
  return out;
}

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
    buildOverlayAss({ words: inp.words, duration, hook: inp.hook, handle: inp.handle, cta: inp.cta, primary: inp.primary, accent: inp.accent, text: inp.text, width: w, height: h, emphasis: inp.emphasis, layout: inp.layout, points: inp.scenes }),
  );
  const out = path.join(inp.workDir, `final-${profile.name}.mp4`);
  const args: string[] = ["-y"];
  let n = 0;
  const add = (...a: string[]) => {
    args.push(...a);
    return n++;
  };
  const pip = inp.layout === "pip";
  // Every input is bounded to the video length: an endless input that a finished branch stops reading
  // leaves ffmpeg's scheduler waiting on it forever (seen as a stalled render under load).
  const lim = ["-t", (duration + 0.5).toFixed(2)];
  const iVis = inp.isStill ? add("-loop", "1", "-framerate", "30", ...lim, "-i", inp.visualPath) : add("-stream_loop", "-1", ...lim, "-i", inp.visualPath);
  // Explainer layout: slowly moving brand gradient as the canvas (shows wherever no stock visual is available).
  const iBg = pip ? add("-f", "lavfi", "-i", `gradients=s=${Math.round(w / 4)}x${Math.round(h / 4)}:c0=${hex(inp.primary)}:c1=${hex(shade(inp.primary, 0.35))}:c2=${hex(shade(inp.accent, 0.45))}:nb_colors=3:speed=0.012:duration=${(duration + 1).toFixed(2)}:rate=30`) : -1;
  const geo = pipGeometry(w, h);
  // Every layer at the same 30 fps and finite length — mismatched endless inputs can stall ffmpeg's frame sync.
  const len = (duration + 0.5).toFixed(2);
  const loopImg = (p: string) => add("-loop", "1", "-framerate", "30", "-t", len, "-i", p);
  const iMask = pip ? loopImg(await roundedMask(inp.workDir, "pipmask", geo.w, geo.h, geo.r)) : -1;
  const iBMask = pip ? loopImg(await roundedMask(inp.workDir, "pipborder", geo.w + 2 * geo.b, geo.h + 2 * geo.b, geo.r + geo.b)) : -1;
  const iBorder = pip ? add("-f", "lavfi", "-i", `color=c=${hex(inp.accent)}:s=${geo.w + 2 * geo.b}x${geo.h + 2 * geo.b}:r=30:d=${len}`) : -1;
  const iAud = add("-i", inp.audioPath);
  const iMus = inp.musicPath ? add("-stream_loop", "-1", ...lim, "-i", inp.musicPath) : -1;
  const broll = (inp.broll ?? []).filter((b) => b.end > b.start && b.start < duration);
  const iBroll = broll.map((b) =>
    b.kind === "image" ? add("-loop", "1", "-framerate", "30", "-t", (b.end - b.start + 0.2).toFixed(2), "-i", b.path) : add("-t", (b.end - b.start + 0.5).toFixed(2), "-i", b.path),
  );
  const punch = pip ? [] : (inp.punchIns ?? []).filter(([a, b]) => b > a);
  const cuts = [...broll.map((b) => b.start), ...punch.map(([a]) => a)].filter((t) => t > 0.3).sort((a, b) => a - b).slice(0, 10);
  const iSfx = inp.sfx && cuts.length ? add("-i", await makeWhoosh(inp.workDir)) : -1;
  const iBar = add("-f", "lavfi", "-i", `color=c=${inp.accent.replace("#", "0x")}:s=${w}x${Math.round(h / 140)}:r=30:d=${(duration + 0.5).toFixed(2)}`);

  const f: string[] = [];
  // Still fallback gets a slow drift so it does not look frozen.
  const base = inp.isStill
    ? `scale=${Math.round(w * 1.1)}:${Math.round(h * 1.1)}:force_original_aspect_ratio=increase,crop=${w}:${h}:x='(iw-ow)/2+sin(t/2.7)*${Math.round(w * 0.03)}':y='(ih-oh)/2+cos(t/3.1)*${Math.round(h * 0.02)}'`
    : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  // Drawn at quarter size (a smooth gradient loses nothing) — full-size costs ~0.5 s of CPU per second of video.
  if (pip) f.push(`[${iBg}:v]scale=${w}:${h}:flags=bicubic,setsar=1,format=yuv420p[v0]`);
  else f.push(`[${iVis}:v]${base},setsar=1,fps=30[v0]`);
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
    const dim = pip ? ",eq=brightness=-0.07:saturation=1.08" : ""; // keeps the key-point text readable
    f.push(`[${iBroll[k]}:v]${prep}${dim},setsar=1,trim=duration=${len},setpts=PTS-STARTPTS+${b.start.toFixed(2)}/TB[b${k}]`);
    f.push(`[${cur}][b${k}]overlay=enable='between(t,${b.start.toFixed(2)},${b.end.toFixed(2)})':eof_action=pass[vb${k}]`);
    cur = `vb${k}`;
  });
  if (pip) {
    // Your face in a rounded, bordered box: head-and-shoulders crop, downscaled (sharp), lightly sharpened.
    const R = (geo.h / geo.w).toFixed(4);
    const drift = inp.isStill ? "+sin(t/2.7)*iw*0.008" : "";
    f.push(`[${iVis}:v]crop=w='min(iw*0.86,ih/${R})':h='min(iw*0.86,ih/${R})*${R}':x='(iw-ow)/2${drift}':y='min(ih*0.05,ih-oh)',scale=${geo.w}:${geo.h}:flags=lanczos,unsharp=5:5:0.7,setsar=1,fps=30,format=yuva420p[pv]`);
    f.push(`[${iMask}:v]format=gray,scale=${geo.w}:${geo.h}[pm]`, `[pv][pm]alphamerge[pf]`);
    f.push(`[${iBorder}:v]format=yuva420p[bc]`, `[${iBMask}:v]format=gray,scale=${geo.w + 2 * geo.b}:${geo.h + 2 * geo.b}[bm]`, `[bc][bm]alphamerge[bf]`);
    f.push(`[${cur}][bf]overlay=${geo.x - geo.b}:${geo.y - geo.b}:eof_action=pass[vbd]`, `[vbd][pf]overlay=${geo.x}:${geo.y}:eof_action=pass[vpip]`);
    cur = "vpip";
  }
  f.push(`[${cur}]subtitles='${filterPath(ass)}':fontsdir='${filterPath(fontsDir())}'[v1]`);
  f.push(`[v1][${iBar}:v]overlay=x='-w+w*t/${duration.toFixed(3)}':y=H-h:shortest=1[v]`);

  const norm = profile.loudnorm ? ",loudnorm=I=-14:TP=-1.5:LRA=11" : "";
  const mix: string[] = [];
  // Voice: rumble cut, adaptive noise reduction (room hiss / hum / TTS artefacts), gentle broadcast compression.
  const clean = inp.denoise === false ? "" : "highpass=f=80,afftdn=nf=-25:tn=1,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2,";
  f.push(`[${iAud}:a]aresample=44100,${clean}aformat=channel_layouts=stereo${iMus >= 0 ? ",asplit=2[voice][vkey]" : "[voice]"}`);
  mix.push("[voice]");
  if (iMus >= 0) {
    // Music sits under the voice and ducks further while you speak (side-chain), swelling back in the gaps.
    f.push(`[${iMus}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${inp.musicVolume}[mraw]`);
    f.push(`[mraw][vkey]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[mus]`);
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
