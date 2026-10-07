import { download, httpJson } from "../http";
import type { Script, WordTiming } from "../types";

/**
 * B-roll cutaways make a talking head feel edited by a human: 2-3 short, relevant visuals over
 * the speaker's voice. Sources (all free): Pexels videos, Pixabay videos (CC0), and as a key-less
 * fallback an AI still from Pollinations. The face stays on screen >= 75% of the time (brand recall).
 */
export interface Cutaway {
  start: number;
  end: number;
  query: string;
}

export interface BrollAsset extends Cutaway {
  url: string;
  kind: "video" | "image";
  source: string;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Locate a beat's text inside the timed words; returns [start, end] seconds. */
export function locate(beat: string, words: WordTiming[], from = 0): [number, number, number] | null {
  const target = beat.split(/\s+/).map(norm).filter(Boolean);
  if (!target.length) return null;
  const ws = words.map((w) => norm(w.word));
  for (let i = from; i < ws.length; i++) {
    if (ws[i] !== target[0]) continue;
    let ok = 0;
    for (let k = 0; k < Math.min(target.length, 4); k++) if (ws[i + k] === target[k]) ok++;
    if (ok >= Math.min(3, target.length)) {
      const last = Math.min(words.length - 1, i + target.length - 1);
      return [words[i].start, words[last].end, last + 1];
    }
  }
  return null;
}

/** Pick up to `max` cutaways: never during the hook (first 2.5 s) or the sign-off (last 3 s), >= 3 s apart, <= 25% of runtime. */
export function planCutaways(script: Script, words: WordTiming[], duration: number, max = 3): Cutaway[] {
  const out: Cutaway[] = [];
  let cursor = 0;
  let used = 0;
  for (const b of script.beats ?? []) {
    if (!b.broll) continue;
    const loc = locate(b.text, words, cursor);
    if (!loc) continue;
    const [s, e, next] = loc;
    cursor = next;
    const start = Math.max(s + 0.3, 2.5);
    const end = Math.min(e, start + 2.2, duration - 3);
    if (end - start < 1.2) continue;
    if (out.length && start - out[out.length - 1].end < 3) continue;
    if (used + (end - start) > duration * 0.25) break;
    out.push({ start: +start.toFixed(2), end: +end.toFixed(2), query: b.broll });
    used += end - start;
    if (out.length >= max) break;
  }
  return out;
}

async function pexels(query: string): Promise<{ url: string; kind: "video" } | null> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  const r = await httpJson<{ videos: { duration: number; video_files: { link: string; width: number; height: number; file_type: string }[] }[] }>(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=8`,
    { headers: { Authorization: key }, timeoutMs: 15_000, retries: 1 },
  );
  for (const v of r.videos) {
    if (v.duration < 3) continue;
    const f = v.video_files
      .filter((f) => f.file_type === "video/mp4" && f.height >= f.width && f.height >= 960 && f.height <= 1920)
      .sort((a, b) => a.height - b.height)[0];
    if (f) return { url: f.link, kind: "video" };
  }
  return null;
}

async function pixabay(query: string): Promise<{ url: string; kind: "video" } | null> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;
  const r = await httpJson<{ hits: { duration: number; videos: Record<string, { url: string; width: number; height: number }> }[] }>(
    `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&safesearch=true&per_page=10`,
    { timeoutMs: 15_000, retries: 1 },
  );
  for (const h of r.hits) {
    if (h.duration < 3) continue;
    const f = h.videos.medium?.url ? h.videos.medium : h.videos.small;
    if (f?.url) return { url: f.url, kind: "video" };
  }
  return null;
}

async function pollinations(query: string): Promise<{ url: string; kind: "image" } | null> {
  if (process.env.DISABLE_POLLINATIONS === "1") return null;
  const prompt = `cinematic vertical photo, ${query}, realistic, high detail, no text, no watermark`;
  const token = process.env.POLLINATIONS_TOKEN ? `&token=${process.env.POLLINATIONS_TOKEN}` : "";
  return { url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1080&height=1920&nologo=true&seed=${Math.floor(Math.random() * 1e6)}${token}`, kind: "image" };
}

export type BrollFinder = (query: string) => Promise<{ buf: Buffer; kind: "video" | "image"; source: string } | null>;

export const findBroll: BrollFinder = async (query) => {
  for (const [name, fn] of [["pexels", pexels], ["pixabay", pixabay], ["pollinations", pollinations]] as const) {
    try {
      const hit = await fn(query);
      if (!hit) continue;
      const buf = await download(hit.url, 60_000);
      if (buf.length < 5_000) continue;
      return { buf, kind: hit.kind, source: name };
    } catch {
      /* next source */
    }
  }
  return null;
};
