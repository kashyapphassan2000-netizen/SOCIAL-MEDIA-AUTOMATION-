import type { WordTiming } from "../types";

/** #RRGGBB -> ASS &HAABBGGRR (alpha 00 = opaque). */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const a = alpha.toString(16).padStart(2, "0").toUpperCase();
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

export function assTime(t: number): string {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

export function assEscape(s: string): string {
  return s.replace(/\\/g, "/").replace(/[{}]/g, "").replace(/\r?\n/g, " ");
}

/**
 * Estimate word timings when the TTS provider gives none: distribute the audio duration
 * proportionally to word length, with small pauses after punctuation.
 */
export function estimateWordTimings(text: string, duration: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const weight = (w: string) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, "").length) + (/[.!?]$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0);
  const total = words.reduce((a, w) => a + weight(w), 0);
  const lead = Math.min(0.15, duration * 0.02);
  const usable = Math.max(0.1, duration - lead * 2);
  let t = lead;
  return words.map((w) => {
    const d = (weight(w) / total) * usable;
    const r = { word: w, start: t, end: t + d * 0.92 };
    t += d;
    return r;
  });
}

/** Convert ElevenLabs-style character alignment into word timings. */
export function wordsFromCharAlignment(chars: string[], starts: number[], ends: number[]): WordTiming[] {
  const out: WordTiming[] = [];
  let cur = "";
  let s = 0;
  let e = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) {
      if (cur) out.push({ word: cur, start: s, end: e });
      cur = "";
      continue;
    }
    if (!cur) s = starts[i];
    cur += c;
    e = ends[i];
  }
  if (cur) out.push({ word: cur, start: s, end: e });
  return out;
}

export function chunkWords(words: WordTiming[], maxWords = 3, maxChars = 18): WordTiming[][] {
  const chunks: WordTiming[][] = [];
  let cur: WordTiming[] = [];
  for (const w of words) {
    const len = cur.reduce((a, x) => a + x.word.length + 1, 0) + w.word.length;
    if (cur.length && (cur.length >= maxWords || len > maxChars)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[.!?,;:]$/.test(w.word)) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export interface OverlayOpts {
  words: WordTiming[];
  duration: number;
  hook: string;
  handle: string;
  cta: string;
  primary: string;
  accent: string;
  text: string;
  width?: number;
  height?: number;
}

/** Full-video ASS: hook banner, karaoke word captions, handle watermark, end-card CTA. */
export function buildOverlayAss(o: OverlayOpts): string {
  const W = o.width ?? 1080;
  const H = o.height ?? 1920;
  const k = H / 1920;
  const white = assColor(o.text);
  const accent = assColor(o.accent);
  const primary = assColor(o.primary);
  const black = assColor("#000000");
  const dim = assColor(o.text, 0x55);
  const fs = (n: number) => Math.round(n * k);
  const lines: string[] = [];
  const hookEnd = Math.min(3.2, o.duration);
  if (o.hook) {
    lines.push(`Dialogue: 2,${assTime(0)},${assTime(hookEnd)},Hook,,0,0,0,,{\\fad(120,200)}${assEscape(o.hook.toUpperCase())}`);
  }
  for (const chunk of chunkWords(o.words)) {
    for (let i = 0; i < chunk.length; i++) {
      const start = chunk[i].start;
      const end = i + 1 < chunk.length ? chunk[i + 1].start : chunk[chunk.length - 1].end + 0.08;
      if (end <= start) continue;
      const text = chunk
        .map((w, j) => (j === i ? `{\\c${accent}\\fscx112\\fscy112}${assEscape(w.word.toUpperCase())}{\\c${white}\\fscx100\\fscy100}` : assEscape(w.word.toUpperCase())))
        .join(" ");
      lines.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text}`);
    }
  }
  if (o.handle) lines.push(`Dialogue: 0,${assTime(0)},${assTime(o.duration)},Handle,,0,0,0,,${assEscape(o.handle)}`);
  const ctaStart = Math.max(hookEnd, o.duration - 2.6);
  if (o.cta && o.duration > 6) {
    lines.push(`Dialogue: 3,${assTime(ctaStart)},${assTime(o.duration)},Cta,,0,0,0,,{\\fad(150,0)}${assEscape(o.cta.toUpperCase())}`);
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Montserrat ExtraBold,${fs(88)},${white},${white},${black},${assColor("#000000", 0x60)},-1,0,0,0,100,100,0,0,1,${fs(7)},${fs(3)},2,${fs(70)},${fs(70)},${fs(560)},1
Style: Hook,Montserrat ExtraBold,${fs(64)},${white},${white},${primary},${primary},-1,0,0,0,100,100,0,0,3,${fs(22)},0,8,${fs(80)},${fs(80)},${fs(250)},1
Style: Handle,Montserrat ExtraBold,${fs(36)},${dim},${dim},${assColor("#000000", 0x90)},${black},-1,0,0,0,100,100,0,0,1,${fs(2)},0,9,${fs(40)},${fs(48)},${fs(120)},1
Style: Cta,Montserrat ExtraBold,${fs(60)},${primary},${primary},${accent},${accent},-1,0,0,0,100,100,0,0,3,${fs(26)},0,5,${fs(90)},${fs(90)},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
}

export function buildThumbnailAss(text: string, handle: string, primary: string, accent: string, W = 1080, H = 1920): string {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,Montserrat ExtraBold,128,${assColor(primary)},${assColor(primary)},${assColor(accent)},${assColor(accent)},-1,0,0,0,100,100,0,0,3,28,0,2,70,70,520,1
Style: H,Montserrat ExtraBold,46,${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor(primary)},${assColor(primary)},-1,0,0,0,100,100,0,0,3,14,0,8,70,70,140,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,T,,0,0,0,,${assEscape(text.toUpperCase())}
Dialogue: 0,0:00:00.00,0:00:10.00,H,,0,0,0,,${assEscape(handle)}
`;
}
