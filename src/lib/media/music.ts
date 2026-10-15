/**
 * Original background music, synthesized per video — no samples, no third-party recordings.
 *
 * Why generate instead of downloading "royalty-free" tracks: on YouTube a Content ID claim on the music
 * sends the video's ad revenue to the claimant (and on Shorts it changes the revenue share), Instagram /
 * Facebook mute or block recognised songs, and "free" libraries change licences or get re-registered by
 * third parties. A track that exists nowhere else cannot be claimed. Your own licensed tracks (e.g. the
 * YouTube Audio Library, which is monetization-safe on YouTube) can still be uploaded and rotated instead.
 *
 * Style: soft lo-fi / tech-explainer bed — pad chords, sub bass, light kick + hats, a quiet pluck arpeggio,
 * side-chain pumping, fades in/out. Mixed ~-20 dB under the voice and ducked further while you speak.
 */

export type MusicMood = "calm" | "upbeat" | "tense";

const SR = 44100;

/** Small deterministic PRNG so the same seed always gives the same track (reproducible renders). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

// Chord progressions as scale degrees (semitone offsets of the chord root from the key) + quality.
const PROGRESSIONS: [number, "maj" | "min"][][] = [
  [[0, "maj"], [7, "maj"], [9, "min"], [5, "maj"]], // I V vi IV
  [[9, "min"], [5, "maj"], [0, "maj"], [7, "maj"]], // vi IV I V
  [[0, "maj"], [9, "min"], [5, "maj"], [7, "maj"]], // I vi IV V
  [[2, "min"], [7, "maj"], [0, "maj"], [9, "min"]], // ii V I vi
];

/**
 * Score cues — what top short-form editors do by hand:
 *  - drop: the music cuts out for the re-hook line ("But here's the part nobody's talking about") so the
 *    words land in silence; a riser builds into it and an impact hit brings the music back on the payoff.
 */
export interface MusicCues {
  drop?: { at: number; dur: number };
}

/** BPM is the first thing drawn from the seed, so the editor can snap cuts/zooms to the beat without rendering. */
export function tempoOf(seed: number, mood: MusicMood = "upbeat"): number {
  const r = rng(seed);
  return mood === "calm" ? 84 + Math.floor(r() * 8) : mood === "tense" ? 100 + Math.floor(r() * 10) : 92 + Math.floor(r() * 14);
}

/** Nearest beat time to t (beats start at 0). */
export function snapToBeat(t: number, bpm: number, maxShift = 0.3): number {
  const beat = 60 / bpm;
  const s = Math.round(t / beat) * beat;
  return Math.abs(s - t) <= maxShift ? s : t;
}

export function synthMusic(seconds: number, seed: number, mood: MusicMood = "upbeat", cues: MusicCues = {}): Buffer {
  const r = rng(seed);
  const len = Math.max(1, Math.ceil((seconds + 1) * SR));
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const bpm = mood === "calm" ? 84 + Math.floor(r() * 8) : mood === "tense" ? 100 + Math.floor(r() * 10) : 92 + Math.floor(r() * 14);
  const beat = 60 / bpm;
  const bar = beat * 4;
  const key = 45 + Math.floor(r() * 10); // A2..F#3 root region
  const prog = PROGRESSIONS[Math.floor(r() * PROGRESSIONS.length)];
  const chordAt = (t: number) => prog[Math.floor(t / bar) % prog.length];
  const notes = (c: [number, "maj" | "min"]) => {
    const root = key + 12 + c[0];
    return [root, root + (c[1] === "maj" ? 4 : 3), root + 7, root + 12];
  };

  // --- pad: soft additive tone per chord note, slow attack, side-chain pump on each beat
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const c = chordAt(t);
    const inBar = (t % bar) / bar;
    const env = Math.min(1, inBar * 6) * Math.min(1, (1 - inBar) * 10 + 0.35);
    const pump = 1 - 0.55 * Math.exp(-((t % beat) / beat) * 7);
    let v = 0;
    for (const [k, n] of notes(c).entries()) {
      const f = midi(n) * (1 + (k % 2 ? 0.0025 : -0.0025)); // gentle detune
      const ph = 2 * Math.PI * f * t;
      v += Math.sin(ph) + 0.28 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph);
    }
    const s = v * 0.045 * env * pump;
    L[i] += s * (1 + 0.15 * Math.sin(2 * Math.PI * 0.21 * t));
    R[i] += s * (1 - 0.15 * Math.sin(2 * Math.PI * 0.21 * t));
  }

  // --- bass on beats 1 and 3, kick on every beat (sparser when calm), hats on off-beats
  const beats = Math.floor(seconds / beat) + 2;
  for (let b = 0; b < beats; b++) {
    const t0 = b * beat;
    const i0 = Math.floor(t0 * SR);
    const c = chordAt(t0 + 0.01);
    if (b % 2 === 0) {
      const f = midi(key + c[0]);
      for (let j = 0; j < SR * beat * 1.8 && i0 + j < len; j++) {
        const t = j / SR;
        const s = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * Math.exp(-t * 2.2) * Math.min(1, t * 200) * 0.16;
        L[i0 + j] += s;
        R[i0 + j] += s;
      }
    }
    if (mood !== "calm" || b % 2 === 0) {
      for (let j = 0; j < SR * 0.35 && i0 + j < len; j++) {
        const t = j / SR;
        const f = 50 + 70 * Math.exp(-t * 30);
        const s = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 0.32;
        L[i0 + j] += s;
        R[i0 + j] += s;
      }
    }
    const ih = Math.floor((t0 + beat / 2) * SR);
    let prev = 0;
    for (let j = 0; j < SR * 0.06 && ih + j < len; j++) {
      const n = r() * 2 - 1;
      const hp = n - prev; // crude high-pass: hats, not hiss
      prev = n;
      const s = hp * Math.exp(-(j / SR) * 70) * 0.035;
      L[ih + j] += s * 0.8;
      R[ih + j] += s;
    }
  }

  // --- pluck arpeggio (8th notes) — the "movement" that keeps a 30 s short from feeling static
  if (mood !== "calm") {
    const eighth = beat / 2;
    const steps = Math.floor(seconds / eighth) + 2;
    for (let k = 0; k < steps; k++) {
      if (r() < 0.25) continue; // leave gaps so it breathes
      const t0 = k * eighth;
      const ns = notes(chordAt(t0 + 0.01));
      const f = midi(ns[Math.floor(r() * ns.length)] + 12);
      const i0 = Math.floor(t0 * SR);
      const pan = r() * 0.6 - 0.3;
      for (let j = 0; j < SR * 0.4 && i0 + j < len; j++) {
        const t = j / SR;
        const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * t));
        const s = tri * Math.exp(-t * 9) * 0.05;
        L[i0 + j] += s * (1 - pan);
        R[i0 + j] += s * (1 + pan);
      }
    }
  }

  // --- the drop: silence under the re-hook, riser into it, impact out of it
  if (cues.drop && cues.drop.at > 1.5 && cues.drop.at + cues.drop.dur < seconds - 1) {
    const a = Math.floor(cues.drop.at * SR);
    const b = Math.floor((cues.drop.at + cues.drop.dur) * SR);
    const fade = Math.floor(0.03 * SR);
    for (let i = a; i < b && i < len; i++) {
      const g = i < a + fade ? 1 - (i - a) / fade : i > b - fade ? (i - (b - fade)) / fade : 0;
      L[i] *= g;
      R[i] *= g;
    }
    const riser = Math.floor(1.6 * SR);
    for (let j = 0; j < riser; j++) {
      const i = a - riser + j;
      if (i < 0) continue;
      const x = j / riser;
      const f = 180 + 1400 * x * x;
      const s = (Math.sin(2 * Math.PI * f * (j / SR)) * 0.35 + (r() * 2 - 1) * 0.5) * x * x * 0.09;
      L[i] += s;
      R[i] += s;
    }
    for (let j = 0; j < SR * 1.4 && b + j < len; j++) {
      const t = j / SR;
      const s = (Math.sin(2 * Math.PI * (38 + 40 * Math.exp(-t * 12)) * t) * 0.5 + (r() * 2 - 1) * 0.12 * Math.exp(-t * 25)) * Math.exp(-t * 2.8);
      L[b + j] += s;
      R[b + j] += s;
    }
  }

  // --- room: two feedback delays (cheap reverb), fades, soft clip, normalise
  for (const [ch, d1, d2] of [[L, 0.031, 0.047], [R, 0.037, 0.053]] as const) {
    const a = Math.floor(d1 * SR);
    const b = Math.floor(d2 * SR);
    for (let i = b; i < len; i++) ch[i] += 0.22 * ch[i - a] + 0.16 * ch[i - b];
  }
  const fadeIn = SR * 0.8;
  const fadeOut = SR * 1.5;
  const end = Math.floor(seconds * SR);
  let peak = 1e-9;
  for (let i = 0; i < len; i++) {
    let g = Math.min(1, i / fadeIn);
    if (i > end - fadeOut) g *= Math.max(0, (end - i) / fadeOut);
    L[i] = Math.tanh(L[i] * g * 1.2);
    R[i] = Math.tanh(R[i] * g * 1.2);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  return wav(L, R, 0.89 / peak);
}

function wav(L: Float32Array, R: Float32Array, gain: number): Buffer {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * gain * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * gain * 32767))), 46 + i * 4);
  }
  return buf;
}

/** Hook style → mood, so the bed matches the energy of the script. */
export function moodFor(hookStyle?: string): MusicMood {
  if (!hookStyle) return "upbeat";
  if (/warning|contrarian|mistake|myth/i.test(hookStyle)) return "tense";
  if (/story|question|personal/i.test(hookStyle)) return "calm";
  return "upbeat";
}

export function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
