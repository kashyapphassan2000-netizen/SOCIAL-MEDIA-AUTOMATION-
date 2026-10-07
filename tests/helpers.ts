import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryKV, setKV } from "@/lib/store/kv";
import { LocalStorage, setStorage } from "@/lib/storage";
import { setSheetWriter, type SheetWriter, type Tab } from "@/lib/sheets";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import { PICK_SYSTEM } from "@/lib/ai/prompts";
import type { LLM } from "@/lib/ai/llm";
import type { VoiceProvider } from "@/lib/ai/voice";
import type { AvatarProvider } from "@/lib/ai/avatar";
import type { Publisher } from "@/lib/publishers";
import { listActiveJobs, saveAssets, saveJob, saveSchedule } from "@/lib/db";
import { PLATFORMS, type Platform, type Schedule } from "@/lib/types";
import { HttpFailure } from "@/lib/http";

export const work = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));

export class MemorySheet implements SheetWriter {
  rows: { tab: Tab; row: string[] }[] = [];
  fail = false;
  async append(tab: Tab, rows: string[][]) {
    if (this.fail) throw new Error("Sheets API down");
    for (const row of rows) this.rows.push({ tab, row });
  }
}

export async function fixtures() {
  const photo = path.join(work, "photo.jpg");
  const clip = path.join(work, "clip.mp4");
  if (!fs.existsSync(photo)) {
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:d=1", "-frames:v", "1", photo]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=f=180:d=6", "-c:a", "libmp3lame", clip.replace(".mp4", ".mp3")]);
  }
  return { photo: `file://${photo}`, voice: `file://${clip.replace(".mp4", ".mp3")}` };
}

export async function setup() {
  const kv = new MemoryKV();
  setKV(kv);
  const storage = new LocalStorage(fs.mkdtempSync(path.join(work, "blobs-")));
  setStorage(storage);
  const sheet = new MemorySheet();
  setSheetWriter(sheet);
  const fx = await fixtures();
  await saveAssets({ photoUrl: fx.photo, voiceSampleUrl: fx.voice });
  return { kv, storage, sheet, fx };
}

export const SPOKEN =
  "OpenAI just dropped a model that writes code faster than most junior developers. Here is what that actually means for you. " +
  "First, boring tasks like tests and boilerplate are now basically free. Second, the people who win are the ones who review and direct the AI, not the ones who type fastest. " +
  "My take? Learn to describe problems clearly, because that is the new programming skill. Would you trust AI to ship your code? Follow for daily AI news.";

export const BEATS = [
  { text: "First, boring tasks like tests and boilerplate are now basically free.", broll: "programmer laptop code", emphasis: "free" },
  { text: "Second, the people who win are the ones who review and direct the AI, not the ones who type fastest.", broll: "team meeting office", emphasis: "direct" },
  { text: "My take? Learn to describe problems clearly, because that is the new programming skill.", broll: "whiteboard planning", emphasis: "skill" },
];

export function mockLLM(opts: { failFirst?: boolean; beats?: boolean } = {}): LLM & { calls: number } {
  let calls = 0;
  return {
    name: "mock-llm",
    get calls() {
      return calls;
    },
    available: () => true,
    async complete(system: string) {
      calls++;
      if (opts.failFirst && calls === 1) throw new Error("simulated 529 overloaded");
      if (system === PICK_SYSTEM) return JSON.stringify({ index: 0, viralityScore: 88, angle: "what it means for developers", why: "huge" });
      const captions = Object.fromEntries(PLATFORMS.map((p) => [p, `${p} caption about the new model #AI`]));
      return "```json\n" + JSON.stringify({
        hook: "OpenAI just dropped a model that writes code faster than most junior developers.",
        spoken: SPOKEN,
        onScreenHook: "AI just replaced juniors?",
        title: "This AI Writes Code Faster Than Juniors",
        description: "New coding model explained in 45 seconds.",
        hashtags: ["AI", "OpenAI", "coding", "tech"],
        thumbnailText: "JUNIOR DEVS?",
        cta: "Follow for daily AI news",
        pinnedComment: "Would you let AI ship your code? Yes or no?",
        ...(opts.beats ? { beats: BEATS } : {}),
        captions,
      }) + "\n```";
    },
  } as LLM & { calls: number };
}

export function mockVoice(name = "mock-voice", fail = false): VoiceProvider {
  return {
    name,
    cloned: true,
    available: () => true,
    async synthesize(text) {
      if (fail) throw new Error(`${name} out of credits`);
      const secs = Math.max(4, text.split(/\s+/).length / 2.6);
      const f = path.join(work, `${name}-${Date.now()}.mp3`);
      await runFfmpeg(["-y", "-f", "lavfi", "-i", `sine=f=200:d=${secs.toFixed(2)}`, "-c:a", "libmp3lame", f]);
      return { audio: fs.readFileSync(f), ext: "mp3", contentType: "audio/mpeg" };
    },
  };
}

export function mockAvatar(name: string, behaviour: "ok" | "submit-fails" | "render-fails"): AvatarProvider & { polls: number } {
  const p = {
    name,
    maxSeconds: 60,
    polls: 0,
    available: () => true,
    async submit() {
      if (behaviour === "submit-fails") throw new Error(`${name}: 402 insufficient balance`);
      return { provider: name, requestId: "r1", submittedAt: new Date().toISOString() };
    },
    async poll() {
      p.polls++;
      if (behaviour === "render-fails") return { state: "failed" as const, error: "face not detected" };
      if (p.polls === 1) return { state: "pending" as const };
      const f = path.join(work, `${name}-avatar.mp4`);
      if (!fs.existsSync(f)) {
        await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:d=4:r=25", "-f", "lavfi", "-i", "sine=f=300:d=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", f]);
      }
      return { state: "done" as const, videoUrl: `file://${f}` };
    },
  };
  return p;
}

export type PubBehaviour = "ok" | "async" | "flaky" | "forbidden";

export function mockPublishers(b: Partial<Record<Platform, PubBehaviour>>) {
  const calls: Record<string, number> = {};
  const pubs = {} as Record<Platform, Publisher>;
  for (const platform of PLATFORMS) {
    calls[platform] = 0;
    const mode = b[platform] ?? "ok";
    pubs[platform] = {
      platform,
      async step(inp, prev) {
        calls[platform]++;
        const video = await inp.readVideo();
        if (video.length < 1000) throw new Error("video too small");
        if (mode === "forbidden") throw new HttpFailure(403, '{"error":"insufficient permissions"}', `https://${platform}.test`);
        if (mode === "flaky" && prev.attempts === 0) throw new HttpFailure(503, "upstream timeout", `https://${platform}.test`);
        if (mode === "async" && !prev.pending?.container) {
          return { ...prev, state: "processing", pending: { container: "c1" }, nextAttemptAt: new Date(Date.now() + 30_000).toISOString() };
        }
        return { ...prev, state: "done", postId: `${platform}-1`, url: `https://${platform}.test/p/1` };
      },
    };
  }
  return { pubs, calls };
}

export function schedule(over: Partial<Schedule> = {}): Schedule {
  const now = new Date().toISOString();
  return {
    id: `sch_${Math.random().toString(36).slice(2, 8)}`,
    name: "AI News",
    topic: "AI news",
    instructions: "Indian tech audience, practical angle",
    queries: [],
    language: "en",
    everyHours: 1,
    windowStartHour: 0,
    windowEndHour: 0,
    platforms: [...PLATFORMS],
    targetSeconds: 32,
    publishMode: "live",
    enabled: true,
    createdBy: "owner@test",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** Pretend time passed: make every waiting job / publish step due now. */
export async function fastForward() {
  for (const j of await listActiveJobs()) {
    j.nextAttemptAt = undefined;
    for (const r of Object.values(j.data.publish ?? {})) if (r) r.nextAttemptAt = undefined;
    await saveJob(j);
  }
}

export { saveSchedule };
