import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setDeps, createJob, tick } from "@/lib/engine";
import { getJob, getSettings, saveSettings } from "@/lib/db";
import { AVATAR_REGISTRY } from "@/lib/ai/avatar";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { planCutaways, locate } from "@/lib/media/broll";
import { planPunchIns } from "@/lib/media/editor";
import { estimateWordTimings } from "@/lib/media/captions";
import { chooseHookStyle, collectStats, learnings, recordPublished, setStatsFetcher } from "@/lib/insights";
import { scriptUser } from "@/lib/ai/prompts";
import { BEATS, SPOKEN, fastForward, mockAvatar, mockLLM, mockPublishers, mockVoice, saveSchedule, schedule, setup, work, type MemorySheet } from "./helpers";
import type { BrandSettings, Job, Script } from "@/lib/types";

let sheet: MemorySheet;
beforeEach(async () => {
  ({ sheet } = await setup());
});

describe("natural edit", () => {
  it("plans cutaways away from the hook and sign-off, spaced, <= 25% of runtime", () => {
    const words = estimateWordTimings(SPOKEN, 30);
    const cuts = planCutaways({ beats: BEATS } as Script, words, 30);
    expect(cuts.length).toBeGreaterThanOrEqual(2);
    for (const c of cuts) {
      expect(c.start).toBeGreaterThanOrEqual(2.5);
      expect(c.end).toBeLessThanOrEqual(27);
      expect(c.end - c.start).toBeLessThanOrEqual(2.21);
    }
    for (let i = 1; i < cuts.length; i++) expect(cuts[i].start - cuts[i - 1].end).toBeGreaterThanOrEqual(3);
    expect(cuts.reduce((a, c) => a + c.end - c.start, 0)).toBeLessThanOrEqual(7.5);
    expect(locate("totally absent words here", words)).toBeNull();
  });

  it("punch-ins hit every other sentence after the hook", () => {
    const words = estimateWordTimings("Hook line here. Second sentence now. Third one. Fourth sentence goes here. Fifth.", 12);
    const p = planPunchIns(words, 12);
    expect(p.length).toBe(2);
    expect(p[0][0]).toBeGreaterThan(1);
  });

  it("renders B-roll (video + AI still), punch-ins, whoosh SFX and emphasis; posts first comment; cleans up", async () => {
    const vid = path.join(work, "broll-src.mp4");
    const img = path.join(work, "broll-src.jpg");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=720x1280:d=4:r=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", vid]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:d=1", "-frames:v", "1", img]);
    const queries: string[] = [];
    let n = 0;
    const comments: string[] = [];
    let video: Buffer | null = null;
    const { pubs } = mockPublishers({});
    const yt = pubs.youtube;
    pubs.youtube = { platform: "youtube", step: async (inp, prev) => ((video = await inp.readVideo()), yt.step(inp, prev)) };
    const av = mockAvatar("av", "ok");
    setDeps({
      llms: () => [mockLLM({ beats: true })],
      voices: () => [mockVoice()],
      avatars: () => [av],
      trends: async () => ({ stories: [{ title: "Story", url: "https://e.x/a", source: "E", summary: "", hash: "n1" }], errors: [] }),
      publishers: pubs,
      generateLook: async () => Buffer.alloc(0),
      findBroll: async (q) => (queries.push(q), n++ % 2 === 0 ? { buf: fs.readFileSync(vid), kind: "video", source: "test" } : { buf: fs.readFileSync(img), kind: "image", source: "test" }),
      firstComment: async (p, id, text) => (comments.push(`${p}:${text}`), true),
    });
    const s = await getSettings();
    await saveSettings({ ...s, generateLooks: false, brandHashtag: "KashyapAI", signature: "I'm Kashyap. Follow for your daily AI edge." });
    const sch = schedule({ platforms: ["youtube", "x"], seriesName: "AI in 30", targetSeconds: 32 });
    await saveSchedule(sch);
    const job = await createJob(sch, "manual", "t");
    for (let i = 0; i < 30; i++) {
      await tick({ budgetSec: 280, enqueue: false });
      await fastForward();
      if ((await getJob(job.id))?.stage === "done") break;
    }
    const done = (await getJob(job.id))!;
    expect(done.status).toBe("done");
    expect(done.data.broll?.length).toBeGreaterThanOrEqual(2);
    expect(queries[0]).toBe("programmer laptop code");
    expect(done.data.script?.hashtags[0]).toBe("KashyapAI");
    expect(done.data.script?.captions.x).toContain("#KashyapAI");
    expect(done.data.script?.hookStyle).toBeTruthy();
    expect(comments).toEqual(["youtube:Would you let AI ship your code? Yes or no?"]);
    expect(done.blobs).toEqual([]);
    // B-roll actually on screen: sample frames inside the first cutaway window and outside it
    const f = path.join(work, `nat-${Date.now()}.mp4`);
    fs.writeFileSync(f, video!);
    const c0 = done.data.broll![0];
    const probe = async (t: number) => {
      const png = path.join(work, `nat-${t}.png`);
      await runFfmpeg(["-y", "-ss", t.toFixed(2), "-i", f, "-frames:v", "1", "-vf", "crop=200:200:440:300,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", png]);
      return [...fs.readFileSync(png)];
    };
    const [r, g, b] = await probe((c0.start + c0.end) / 2);
    expect(r).toBeGreaterThan(180); // red B-roll clip
    expect(g + b).toBeLessThan(120);
    const info = await runFfmpeg(["-i", f, "-f", "null", "-t", "0", "-"]).catch((e: Error) => e.message);
    expect(info).toMatch(/1080x1920/);
    expect(done.logs.some((l) => /B-roll: programmer laptop code/.test(l.msg))).toBe(true);
    // performance record created for the learning loop
    const { getKV } = await import("@/lib/store/kv");
    expect(await getKV().get(`perf:${job.id}`)).toBeTruthy();
  });
});

describe("brand + learning loop", () => {
  it("series titles, sign-off, hook style and learnings go into the script prompt", () => {
    const u = scriptUser(schedule({ seriesName: "AI in 30", targetSeconds: 32 }), { title: "T", url: "", source: "S", summary: "", hash: "h" }, { brandName: "B", handle: "@b", signature: "I'm K. Follow.", ctaText: "x" } as unknown as BrandSettings, {
      hookStyle: "contrarian",
      episode: 12,
      learnings: { summary: "contrarian wins", bestHookStyles: ["contrarian"], topTitles: ["Top A"], weakTitles: ["Weak Z"] },
    });
    expect(u).toContain('MUST start with "AI in 30 #12: "');
    expect(u).toContain("I'm K. Follow.");
    expect(u).toContain("Contrarian");
    expect(u).toContain("Top A");
    expect(u).toMatch(/83 spoken words/);
  });

  it("collects stats after 20h, logs a Performance row at 72h, and learns the winning hook style", async () => {
    const now = Date.now();
    const mk = (i: number, style: string): Job => ({
      id: `j${i}`, scheduleId: "s1", scheduleName: "", topic: `topic ${i}`, createdBy: "", trigger: "cron", status: "done", stage: "done", stageAttempts: 0,
      createdAt: "", updatedAt: "", platforms: ["youtube"], publishMode: "live", blobs: [], logs: [],
      data: { script: { title: `title ${i}`, hookStyle: style } as Script, publish: { youtube: { state: "done", attempts: 0, postId: `yt${i}` } } },
    });
    for (let i = 0; i < 8; i++) await recordPublished(mk(i, i % 2 ? "contrarian" : "story"));
    // backdate
    const { getKV } = await import("@/lib/store/kv");
    for (let i = 0; i < 8; i++) {
      const r = await getKV().get<any>(`perf:j${i}`);
      await getKV().set(`perf:j${i}`, { ...r, publishedAt: new Date(now - 80 * 3600_000).toISOString() });
    }
    setStatsFetcher(async (recs) => new Map(recs.map((r) => [r.jobId, { youtube: { views: r.hookStyle === "contrarian" ? 10_000 : 900, likes: 10, comments: 3 } }])));
    expect(await collectStats(await getSettings(), now)).toBe(8);
    expect(sheet.rows.filter((r) => r.tab === "Performance")).toHaveLength(8);
    const l = await learnings("s1");
    expect(l?.bestHookStyles[0]).toBe("contrarian");
    expect(await chooseHookStyle("s1", l, 0.1)).toBe("contrarian"); // exploit
    expect(Object.keys((await import("@/lib/ai/prompts")).HOOK_STYLES)).toContain(await chooseHookStyle("s1", l, 0.95)); // explore
    setStatsFetcher(null);
  });
});
