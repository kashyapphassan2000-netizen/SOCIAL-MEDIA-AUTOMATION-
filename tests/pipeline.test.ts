import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { setDeps, tick, createJob, isDue } from "@/lib/engine";
import { getJob, listRecentJobs, getSettings, saveSettings, getAssets, saveAssets, isStoryUsed } from "@/lib/db";
import { flushSheet } from "@/lib/sheets";
import { AVATAR_REGISTRY } from "@/lib/ai/avatar";
import type { Story } from "@/lib/types";
import { fastForward, mockAvatar, mockLLM, mockPublishers, mockVoice, saveSchedule, schedule, setup, type MemorySheet } from "./helpers";

const STORIES: Story[] = [
  { title: "OpenAI launches a new coding model", url: "https://example.com/a", source: "Example", summary: "Faster and cheaper", hash: "h1" },
  { title: "Google ships Gemini update", url: "https://example.com/b", source: "Example", summary: "", hash: "h2" },
];
const trends = async () => ({ stories: STORIES, errors: ["reddit: 403"] });

async function runUntilDone(jobId: string, maxTicks = 40) {
  for (let i = 0; i < maxTicks; i++) {
    const tr = await tick({ budgetSec: 280, enqueue: false });
    const j = await getJob(jobId);
    if (process.env.DEBUG_TICK) console.log(JSON.stringify(tr), j?.stage, j?.status, j?.nextAttemptAt);
    if (!j || j.stage === "done") return j;
    await fastForward();
  }
  return getJob(jobId);
}

let sheet: MemorySheet;
beforeEach(async () => {
  ({ sheet } = await setup());
});

describe("full pipeline", () => {
  it("researches, scripts, voices, renders, publishes everywhere, logs to sheet and deletes media", async () => {
    const llm = mockLLM({ failFirst: true });
    const omni = mockAvatar("omni", "submit-fails");
    const fabric = mockAvatar("fabric", "ok");
    const { pubs, calls } = mockPublishers({ instagram: "async", x: "flaky", linkedin: "forbidden" });
    setDeps({
      llms: () => [llm],
      voices: () => [mockVoice("eleven", true), mockVoice("f5")],
      avatars: () => [omni, fabric, AVATAR_REGISTRY.still],
      trends,
      publishers: pubs,
      generateLook: async () => fs.readFileSync((await getAssets()).photoUrl!.slice(7)),
    });
    const sch = schedule();
    await saveSchedule(sch);
    const job = await createJob(sch, "manual", "owner@test");
    const done = await runUntilDone(job.id);

    expect(done?.stage).toBe("done");
    // linkedin permanently forbidden -> partial, everything else posted
    expect(done?.status).toBe("partial");
    expect(done?.data.publish?.youtube?.state).toBe("done");
    expect(done?.data.publish?.instagram?.state).toBe("done");
    expect(done?.data.publish?.x?.state).toBe("done");
    expect(done?.data.publish?.x?.attempts).toBe(1); // one transient failure, then success
    expect(done?.data.publish?.linkedin?.state).toBe("failed");
    expect(calls.linkedin).toBe(1); // permanent error -> no pointless retries
    expect(calls.instagram).toBe(2); // container created, then published
    // fallbacks were used and recorded
    expect(done?.data.voiceProvider).toBe("f5");
    expect(done?.data.avatarProvider).toBe("fabric");
    expect(done?.data.editMode).toBe("full-1080p");
    expect(done?.data.lookName).toBeTruthy();
    // generated media deleted after upload
    expect(done?.blobs).toEqual([]);
    for (const u of [done!.data.videoUrl!, done!.data.audioUrl!, done!.data.thumbnailUrl!]) expect(fs.existsSync(u.slice(7))).toBe(false);
    // the story can never be reused by this schedule
    expect(await isStoryUsed(sch.id, "h1")).toBe(true);
    // permanent log row in the sheet
    const runs = sheet.rows.filter((r) => r.tab === "Runs");
    expect(runs).toHaveLength(1);
    expect(runs[0].row).toContain("PARTIAL");
    expect(runs[0].row.join(" ")).toContain("https://youtube.test/p/1");
    expect(runs[0].row.join(" ")).toMatch(/FAILED: .*403/);
    // generated look cached for reuse
    const s = await getSettings();
    expect(s.looks.filter((l) => l.imageUrl).length).toBe(1);
  });

  it("rendered video is a valid 1080x1920 H.264 short", async () => {
    const { pubs } = mockPublishers({});
    let captured: Buffer | null = null;
    pubs.youtube = { platform: "youtube", step: async (inp, prev) => ((captured = await inp.readVideo()), { ...prev, state: "done", url: "u" }) };
    const av = mockAvatar("a", "ok");
    setDeps({ llms: () => [mockLLM()], voices: () => [mockVoice()], avatars: () => [av], trends, publishers: pubs, generateLook: async () => Buffer.alloc(0) });
    const s = await getSettings();
    await saveSettings({ ...s, generateLooks: false });
    const sch = schedule({ platforms: ["youtube"] });
    await saveSchedule(sch);
    const job = await createJob(sch, "manual", "t");
    const done = await runUntilDone(job.id);
    expect(done?.status).toBe("done");
    expect(captured).not.toBeNull();
    const f = `${process.env.TMPDIR ?? "/tmp"}/sa-check-${Date.now()}.mp4`;
    fs.writeFileSync(f, captured!);
    const { runFfmpeg } = await import("@/lib/media/ffmpeg");
    const info = await runFfmpeg(["-i", f, "-f", "null", "-t", "0", "-"]).catch((e: Error) => e.message);
    expect(info).toMatch(/h264.*1080x1920/);
    expect(info).toMatch(/Audio: aac/);
  });

  it("still-image fallback works with PNG photos (extension sniffed from bytes)", async () => {
    const { runFfmpeg } = await import("@/lib/media/ffmpeg");
    const os = await import("node:os");
    const png = `${os.tmpdir()}/sa-photo-${Date.now()}.png`;
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:d=1", "-frames:v", "1", png]);
    await saveAssets({ ...(await getAssets()), photoUrl: `file://${png}` });
    const s = await getSettings();
    await saveSettings({ ...s, generateLooks: false });
    const { pubs } = mockPublishers({});
    setDeps({ llms: () => [mockLLM()], voices: () => [mockVoice()], avatars: () => [AVATAR_REGISTRY.still], trends, publishers: pubs, generateLook: async () => Buffer.alloc(0) });
    const sch = schedule({ platforms: ["youtube"] });
    await saveSchedule(sch);
    const done = await runUntilDone((await createJob(sch, "manual", "t")).id);
    expect(done?.status).toBe("done");
    expect(done?.data.editMode).toBe("full-1080p");
  });

  it("private test mode posts only to YouTube (private) and skips the rest", async () => {
    const { pubs, calls } = mockPublishers({});
    let privacy = false;
    const yt = pubs.youtube;
    pubs.youtube = { platform: "youtube", step: async (inp, prev) => ((privacy = inp.privateMode), yt.step(inp, prev)) };
    setDeps({ llms: () => [mockLLM()], voices: () => [mockVoice()], avatars: () => [AVATAR_REGISTRY.still], trends, publishers: pubs, generateLook: async () => Buffer.alloc(0) });
    const sch = schedule({ publishMode: "private" });
    await saveSchedule(sch);
    const done = await runUntilDone((await createJob(sch, "manual", "t")).id);
    expect(done?.status).toBe("done");
    expect(privacy).toBe(true);
    expect(calls.instagram + calls.x + calls.facebook + calls.threads + calls.linkedin).toBe(0);
    expect(done?.data.publish?.instagram?.state).toBe("skipped");
    expect(done?.data.avatarProvider).toContain("still");
  });

  it("never publishes a stranger's voice: clone failure + generic disabled => job fails cleanly and is logged", async () => {
    const { pubs, calls } = mockPublishers({});
    setDeps({ llms: () => [mockLLM()], voices: () => [mockVoice("eleven", true)], avatars: () => [AVATAR_REGISTRY.still], trends, publishers: pubs, generateLook: async () => Buffer.alloc(0) });
    const sch = schedule();
    await saveSchedule(sch);
    const done = await runUntilDone((await createJob(sch, "manual", "t")).id);
    expect(done?.stage).toBe("done");
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/voice/);
    expect(Object.values(calls).reduce((a, b) => a + b, 0)).toBe(0);
    expect(sheet.rows.find((r) => r.tab === "Runs")?.row).toContain("FAILED");
  });

  it("missing photo fails with an actionable message", async () => {
    const { pubs } = mockPublishers({});
    setDeps({ llms: () => [mockLLM()], voices: () => [mockVoice()], avatars: () => [AVATAR_REGISTRY.still], trends, publishers: pubs, generateLook: async () => Buffer.alloc(0) });
    await saveAssets({});
    const sch = schedule();
    await saveSchedule(sch);
    const done = await runUntilDone((await createJob(sch, "manual", "t")).id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/upload your photo/i);
  });

  it("buffers sheet rows while Google is down and flushes later", async () => {
    const { pubs } = mockPublishers({});
    setDeps({ llms: () => [mockLLM()], voices: () => [mockVoice()], avatars: () => [AVATAR_REGISTRY.still], trends, publishers: pubs, generateLook: async () => Buffer.alloc(0) });
    sheet.fail = true;
    const sch = schedule({ platforms: ["youtube", "x"] });
    await saveSchedule(sch);
    await runUntilDone((await createJob(sch, "manual", "t")).id);
    expect(sheet.rows).toHaveLength(0);
    sheet.fail = false;
    expect(await flushSheet()).toBe(1);
    expect(sheet.rows[0].row).toContain("DONE");
  });

  it("enqueues due schedules hourly, respects daily video cap and one-active-job-per-schedule", async () => {
    const { pubs } = mockPublishers({});
    setDeps({ llms: () => [mockLLM()], voices: () => [mockVoice()], avatars: () => [AVATAR_REGISTRY.still], trends, publishers: pubs, generateLook: async () => Buffer.alloc(0) });
    const s = await getSettings();
    await saveSettings({ ...s, maxVideosPerDay: 2 });
    await saveSchedule(schedule({ id: "a" }));
    await saveSchedule(schedule({ id: "b" }));
    await saveSchedule(schedule({ id: "c" }));
    const r1 = await tick({ budgetSec: 1 }); // budget too small to process: only enqueue
    expect(r1.created).toBe(2); // cap = 2
    const r2 = await tick({ budgetSec: 1 });
    expect(r2.created).toBe(0);
    expect((await listRecentJobs()).length).toBe(2);
  });
});

describe("preflight", () => {
  it("does not burn the daily cap when setup is incomplete, and says why", async () => {
    const { pubs } = mockPublishers({});
    setDeps({ llms: () => [mockLLM()], voices: () => [mockVoice()], avatars: () => [AVATAR_REGISTRY.still], trends, publishers: pubs, generateLook: async () => Buffer.alloc(0) });
    await saveAssets({});
    await saveSchedule(schedule());
    const r = await tick({ budgetSec: 1 });
    expect(r.created).toBe(0);
    const { getKV } = await import("@/lib/store/kv");
    expect((await getKV().get<{ problems: string[] }>("worker:blocked"))?.problems).toContain("no creator photo uploaded");
  });
});

describe("isDue", () => {
  const tz = "Asia/Kolkata";
  it("handles interval, window and disabled", () => {
    const now = new Date("2026-10-07T06:30:00Z"); // 12:00 IST
    expect(isDue(schedule({ lastRunAt: new Date(now.getTime() - 55 * 60_000).toISOString() }), tz, [], now)).toBe(true); // within 10min tolerance
    expect(isDue(schedule({ lastRunAt: new Date(now.getTime() - 30 * 60_000).toISOString() }), tz, [], now)).toBe(false);
    expect(isDue(schedule({ everyHours: 3, lastRunAt: new Date(now.getTime() - 2 * 3600_000).toISOString() }), tz, [], now)).toBe(false);
    expect(isDue(schedule({ windowStartHour: 9, windowEndHour: 11 }), tz, [], now)).toBe(false);
    expect(isDue(schedule({ windowStartHour: 9, windowEndHour: 22 }), tz, [], now)).toBe(true);
    expect(isDue(schedule({ windowStartHour: 22, windowEndHour: 2 }), tz, [], new Date("2026-10-07T18:00:00Z"))).toBe(true); // 23:30 IST overnight window
    expect(isDue(schedule({ enabled: false }), tz, [], now)).toBe(false);
  });
});
