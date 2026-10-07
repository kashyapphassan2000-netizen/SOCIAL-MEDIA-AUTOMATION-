import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached: string | null = null;

export function ffmpegPath(): string {
  if (cached) return cached;
  if (process.env.FFMPEG_PATH) return (cached = process.env.FFMPEG_PATH);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) return (cached = p);
  } catch {
    /* fall through to system ffmpeg */
  }
  const local = path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  if (fs.existsSync(local)) return (cached = local);
  return (cached = "ffmpeg");
}

export function fontsDir(): string {
  return path.join(process.cwd(), "assets", "fonts");
}

export async function runFfmpeg(args: string[], timeoutMs = 240_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(/*turbopackIgnore: true*/ ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg exited ${code}: ${err.split("\n").slice(-12).join("\n")}`));
    });
  });
}

/** Duration in seconds, parsed from ffmpeg's banner (no ffprobe in ffmpeg-static). */
export async function probeDuration(file: string): Promise<number> {
  const out = await runFfmpeg(["-i", file, "-f", "null", "-t", "0", "-"]).catch((e: Error) => e.message);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  if (!m) throw new Error(`Could not read media duration of ${path.basename(file)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export async function hasAudioStream(file: string): Promise<boolean> {
  const out = await runFfmpeg(["-i", file, "-f", "null", "-t", "0", "-"]).catch((e: Error) => e.message);
  return /Stream #\d+:\d+.*Audio:/.test(out);
}

export async function hasVideoStream(file: string): Promise<boolean> {
  const out = await runFfmpeg(["-i", file, "-f", "null", "-t", "0", "-"]).catch((e: Error) => e.message);
  return /Stream #\d+:\d+.*Video:/.test(out) && !/Video: (mjpeg|png).*attached pic/.test(out);
}

export function tmpDir(prefix = "sa-"): string {
  return fs.mkdtempSync(path.join(/*turbopackIgnore: true*/ os.tmpdir(), prefix));
}

export function rmrf(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Normalise any voice clip (mp4/mov/m4a/wav) to mono 44.1k mp3 for cloning, trimmed to maxSec. */
export async function extractVoice(input: string, out: string, maxSec = 120) {
  await runFfmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "44100", "-t", String(maxSec), "-af", "highpass=f=70,loudnorm=I=-16:TP=-1.5", "-c:a", "libmp3lame", "-b:a", "160k", out]);
}

/** File extension from magic bytes — ffmpeg's image demuxer trusts the extension. */
export function imageExt(buf: Buffer): "png" | "webp" | "jpg" {
  if (buf.length > 4 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "jpg";
}
