import { describe, expect, it } from "vitest";
import { moodFor, seedFrom, snapToBeat, synthMusic, tempoOf } from "@/lib/media/music";
import { findReHook } from "@/lib/engine";

const rms = (buf: Buffer, from: number, to: number) => {
  let s = 0;
  let n = 0;
  for (let i = 44 + Math.floor(from * 44100) * 4; i < 44 + Math.floor(to * 44100) * 4 && i < buf.length - 1; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    s += v * v;
    n++;
  }
  return Math.sqrt(s / Math.max(1, n));
};

describe("original music", () => {
  it("renders a valid stereo WAV of the requested length, same seed = same track", () => {
    const a = synthMusic(10, 42, "upbeat");
    expect(a.toString("ascii", 0, 4)).toBe("RIFF");
    expect(a.readUInt16LE(22)).toBe(2);
    expect((a.length - 44) / 4 / 44100).toBeGreaterThanOrEqual(10);
    expect(synthMusic(10, 42, "upbeat").equals(a)).toBe(true);
    expect(rms(a, 2, 8)).toBeGreaterThan(0.05);
  });

  it("drops out under the re-hook and comes back with an impact", () => {
    const w = synthMusic(20, 7, "upbeat", { drop: { at: 9, dur: 1.5 } });
    expect(rms(w, 9.1, 10.4)).toBeLessThan(0.02);
    expect(rms(w, 10.5, 11.5)).toBeGreaterThan(0.05);
    expect(rms(w, 7.6, 8.9)).toBeGreaterThan(rms(w, 4, 5) * 0.5); // riser present
  });

  it("knows its tempo so cuts can land on the beat", () => {
    const bpm = tempoOf(seedFrom("job_x"), "upbeat");
    expect(bpm).toBeGreaterThanOrEqual(92);
    expect(bpm).toBeLessThan(106);
    const beat = 60 / bpm;
    expect(snapToBeat(beat * 5 + 0.1, bpm)).toBeCloseTo(beat * 5, 5);
    expect(snapToBeat(beat * 5 + beat / 2, bpm, 0.05)).toBeCloseTo(beat * 5 + beat / 2, 5); // too far: unchanged
    expect(moodFor("warning")).toBe("tense");
  });

  it("finds the re-hook line in the word timings", () => {
    const text = "Google just dropped something huge today and it matters for you. But here's the part nobody's talking about, it is cheap. Follow for more.";
    const words = text.split(" ").map((w, i) => ({ word: w, start: i * 0.6, end: i * 0.6 + 0.5 }));
    const d = findReHook(words, words.length * 0.6)!;
    const i = text.split(" ").indexOf("But");
    expect(d.at).toBeCloseTo(i * 0.6 - 0.08, 2);
    expect(d.dur).toBeGreaterThan(1);
    expect(findReHook(words.slice(0, 5), 2)).toBeUndefined();
  });
});
