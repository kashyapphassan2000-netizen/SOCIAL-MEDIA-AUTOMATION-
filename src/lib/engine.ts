import fs from "node:fs";
import path from "node:path";
import { LLM_REGISTRY, generateJson, type LLM } from "./ai/llm";
import { PICK_SYSTEM, SCRIPT_SYSTEM, pickUser, scriptUser, validateScript } from "./ai/prompts";
import { fetchTrends, storyHash, type TrendFetcher } from "./ai/trends";
import { VOICE_REGISTRY, type VoiceProvider } from "./ai/voice";
import { AVATAR_REGISTRY, type AvatarProvider } from "./ai/avatar";
import { generateLook } from "./ai/looks";
import { PUBLISHERS, isPermanent, type Publisher } from "./publishers";
import { ReauthRequired } from "./connections";
import { estimateWordTimings } from "./media/captions";
import { PROFILES, renderShort } from "./media/editor";
import { probeDuration, rmrf, runFfmpeg, tmpDir } from "./media/ffmpeg";
import { getStorage, type Storage } from "./storage";
import { getKV } from "./store/kv";
import { jobRow, flushSheet, logRow } from "./sheets";
import {
  bumpDayCount, getAssets, getDayCount, getSchedule, getSettings, isStoryUsed, listActiveJobs, listSchedules,
  markStoryUsed, newJob, nextLookIndex, platformCapReached, saveAssets, saveJob, saveSchedule, saveSettings,
} from "./db";
import type { BrandSettings, Job, Platform, PublishResult, Schedule, Stage, Story } from "./types";

export interface Deps {
  llms: (s: BrandSettings) => LLM[];
  voices: (s: BrandSettings) => VoiceProvider[];
  avatars: (s: BrandSettings) => AvatarProvider[];
  trends: TrendFetcher;
  publishers: Record<Platform, Publisher>;
  generateLook: typeof generateLook;
  storage: () => Storage;
}

const pick = <T,>(reg: Record<string, T>, order: string[]) => order.map((n) => reg[n]).filter((x): x is T => !!x);

export const defaultDeps: Deps = {
  llms: (s) => pick(LLM_REGISTRY, s.llmProviders.length ? s.llmProviders : Object.keys(LLM_REGISTRY)),
  voices: (s) => {
    const list = pick(VOICE_REGISTRY, s.voiceProviders);
    if (s.allowGenericVoiceFallback && !list.includes(VOICE_REGISTRY["openai-tts"])) list.push(VOICE_REGISTRY["openai-tts"]);
    return list;
  },
  avatars: (s) => pick(AVATAR_REGISTRY, s.avatarMode === "clip" ? ["fal-lipsync-clip", ...s.avatarProviders] : s.avatarProviders),
  trends: fetchTrends,
  publishers: PUBLISHERS,
  generateLook,
  storage: getStorage,
};

let deps: Deps = defaultDeps;
export function setDeps(d: Partial<Deps>) {
  deps = { ...defaultDeps, ...d };
}

// ------------------------------------------------------------------
type StageResult = { next: Stage } | { wait: number };

const MAX_ATTEMPTS: Record<Stage, number> = { research: 3, script: 3, look: 2, voice: 4, avatar: 6, edit: 3, publish: 1, cleanup: 5, done: 1 };
/** Seconds of function time a stage needs before we dare start it (Vercel kills at maxDuration). */
const STAGE_BUDGET: Partial<Record<Stage, number>> = { edit: 150, publish: 120, voice: 60, look: 60, script: 60, research: 40 };
const MAX_ACTIVE_JOBS = Number(process.env.MAX_ACTIVE_JOBS || 3);
const AVATAR_TIMEOUT_MIN = 25;

function log(job: Job, level: "info" | "warn" | "error", msg: string) {
  job.logs.push({ t: new Date().toISOString(), stage: job.stage, level, msg: msg.slice(0, 900) });
}
const after = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();

// ---------------------------- stages ----------------------------
async function research(job: Job, s: BrandSettings): Promise<StageResult> {
  const sched = (await getSchedule(job.scheduleId)) ?? ({ topic: job.topic, instructions: "", queries: [], language: "en", targetSeconds: 45 } as unknown as Schedule);
  const queries = sched.queries?.length ? sched.queries : [sched.topic];
  const { stories, errors } = await deps.trends(queries, sched.language || "en");
  if (errors.length) log(job, "warn", `Some trend sources failed: ${errors.slice(0, 3).join(" | ")}`);
  const fresh: Story[] = [];
  for (const st of stories) if (!(await isStoryUsed(job.scheduleId, st.hash))) fresh.push(st);
  const candidates = fresh.slice(0, 30);
  const { data, provider } = await generateJson(deps.llms(s), PICK_SYSTEM, pickUser(sched, candidates), (v) => {
    const o = v as { index: number; viralityScore?: number; angle?: string; evergreen?: { title: string; summary: string } | null };
    if (typeof o.index !== "number") throw new Error("pick.index missing");
    if (o.index >= 0 && !candidates[o.index]) throw new Error("pick.index out of range");
    if (o.index < 0 && !o.evergreen?.title) throw new Error("no story and no evergreen idea");
    return o;
  });
  const story: Story =
    data.index >= 0
      ? { ...candidates[data.index], viralityScore: data.viralityScore, angle: data.angle }
      : { title: data.evergreen!.title, summary: data.evergreen!.summary, url: "", source: "evergreen idea", hash: storyHash(data.evergreen!.title), angle: data.angle, viralityScore: data.viralityScore };
  await markStoryUsed(job.scheduleId, story.hash);
  job.data.story = story;
  log(job, "info", `Picked (${provider}, score ${story.viralityScore ?? "?"}): ${story.title}`);
  return { next: "script" };
}

async function script(job: Job, s: BrandSettings): Promise<StageResult> {
  const sched = (await getSchedule(job.scheduleId)) ?? ({ topic: job.topic, instructions: "", language: "en", targetSeconds: 45 } as unknown as Schedule);
  const target = Math.min(58, Math.max(20, sched.targetSeconds || 45));
  const { data, provider, errors } = await generateJson(deps.llms(s), SCRIPT_SYSTEM, scriptUser({ ...sched, targetSeconds: target }, job.data.story!, s), (v) => validateScript(v, target));
  if (errors.length) log(job, "warn", `LLM retries: ${errors.join(" | ")}`);
  job.data.script = data;
  log(job, "info", `Script by ${provider}: "${data.title}" (${data.spoken.split(/\s+/).length} words)`);
  return { next: "look" };
}

async function look(job: Job, s: BrandSettings): Promise<StageResult> {
  const assets = await getAssets();
  if (s.avatarMode === "clip" && assets.clipUrl) {
    job.data.lookUrl = assets.photoUrl;
    return { next: "voice" };
  }
  if (!assets.photoUrl) throw new Error("No creator photo uploaded — open Studio and upload your photo");
  job.data.lookUrl = assets.photoUrl;
  job.data.lookName = "original photo";
  if (s.generateLooks && s.looks.length) {
    const idx = await nextLookIndex(s.looks.length);
    const lk = s.looks[idx];
    if (lk.imageUrl) {
      job.data.lookUrl = lk.imageUrl;
      job.data.lookName = lk.name;
    } else {
      try {
        const img = await deps.generateLook(assets.photoUrl, lk.prompt, s.primaryColor);
        const url = await deps.storage().put(`looks/${lk.name.replace(/\W+/g, "-")}.jpg`, img, "image/jpeg");
        const fresh = await getSettings();
        if (fresh.looks[idx]?.name === lk.name) {
          fresh.looks[idx] = { ...fresh.looks[idx], imageUrl: url };
          await saveSettings(fresh);
        }
        job.data.lookUrl = url;
        job.data.lookName = lk.name;
        log(job, "info", `Generated new look "${lk.name}"`);
      } catch (e) {
        log(job, "warn", `Look generation failed, using original photo: ${(e as Error).message}`);
      }
    }
  }
  return { next: "voice" };
}

async function voice(job: Job, s: BrandSettings): Promise<StageResult> {
  const assets = await getAssets();
  const text = job.data.script!.spoken;
  const storage = deps.storage();
  const errors: string[] = [];
  for (const v of deps.voices(s)) {
    if (!v.available(assets)) continue;
    if (!v.cloned && !s.allowGenericVoiceFallback) continue;
    try {
      const r = await v.synthesize(text, {
        assets,
        saveVoiceId: async (id) => saveAssets({ ...(await getAssets()), elevenVoiceId: id }),
        readSample: (u) => storage.read(u),
      });
      const dir = tmpDir();
      try {
        const f = path.join(dir, `voice.${r.ext}`);
        fs.writeFileSync(f, r.audio);
        job.data.audioSeconds = await probeDuration(f);
      } finally {
        rmrf(dir);
      }
      job.data.audioUrl = await storage.put(`jobs/${job.id}/voice.${r.ext}`, r.audio, r.contentType);
      job.blobs.push(job.data.audioUrl);
      job.data.words = r.words?.length ? r.words : estimateWordTimings(text, job.data.audioSeconds);
      job.data.voiceProvider = v.name + (v.cloned ? "" : " (generic)");
      if (!v.cloned) log(job, "warn", "Using a GENERIC voice (clone providers failed) — allowed by settings");
      log(job, "info", `Voice by ${v.name}: ${job.data.audioSeconds.toFixed(1)}s`);
      return { next: "avatar" };
    } catch (e) {
      errors.push(`${v.name}: ${(e as Error).message.slice(0, 250)}`);
      log(job, "warn", `Voice provider ${v.name} failed: ${(e as Error).message}`);
    }
  }
  throw new Error(`No voice provider succeeded${errors.length ? "" : " (none configured: add ELEVENLABS_API_KEY or FAL_KEY and upload a voice clip)"}`);
}

async function avatar(job: Job, s: BrandSettings): Promise<StageResult> {
  const providers = deps.avatars(s).filter((p) => p.name !== "still" || s.allowStillImageFallback);
  const assets = await getAssets();
  const input = { imageUrl: job.data.lookUrl!, audioUrl: job.data.audioUrl!, clipUrl: assets.clipUrl, audioSeconds: job.data.audioSeconds ?? 0 };
  const req = job.data.avatar;
  if (req) {
    const p = providers.find((x) => x.name === req.provider);
    const res = p ? await p.poll(req) : ({ state: "failed", error: "provider removed" } as const);
    if (res.state === "pending") {
      const mins = (Date.now() - new Date(req.submittedAt).getTime()) / 60000;
      if (mins < AVATAR_TIMEOUT_MIN) return { wait: mins < 2 ? 40 : 25 };
      log(job, "warn", `${req.provider} still not done after ${mins.toFixed(0)} min — falling back`);
    } else if (res.state === "done") {
      job.data.avatarUrl = res.videoUrl;
      job.data.avatarProvider = req.provider;
      log(job, "info", `Avatar ready from ${req.provider}`);
      return { next: "edit" };
    } else {
      log(job, "warn", `${req.provider} failed: ${res.error}`);
    }
    job.data.avatar = undefined;
    job.data.avatarProviderIndex = (job.data.avatarProviderIndex ?? 0) + 1;
  }
  for (let i = job.data.avatarProviderIndex ?? 0; i < providers.length; i++) {
    const p = providers[i];
    job.data.avatarProviderIndex = i;
    if (!p.available(input)) continue;
    if (input.audioSeconds > p.maxSeconds) {
      log(job, "warn", `${p.name} skipped: audio ${input.audioSeconds.toFixed(0)}s > ${p.maxSeconds}s limit`);
      continue;
    }
    if (p.name === "still") {
      job.data.avatarUrl = "";
      job.data.avatarProvider = "still (no lip-sync)";
      log(job, "warn", "Using animated still photo fallback (no lip-sync)");
      return { next: "edit" };
    }
    try {
      job.data.avatar = await p.submit(input);
      log(job, "info", `Submitted talking-head render to ${p.name}`);
      return { wait: 60 };
    } catch (e) {
      log(job, "warn", `${p.name} submit failed: ${(e as Error).message}`);
    }
  }
  job.data.avatarProviderIndex = 0; // next attempt starts over from the best provider
  throw new Error("All avatar providers failed");
}

async function edit(job: Job, s: BrandSettings): Promise<StageResult> {
  const storage = deps.storage();
  const dir = tmpDir();
  try {
    const still = !job.data.avatarUrl;
    const visual = path.join(dir, still ? "visual.jpg" : "visual.mp4");
    fs.writeFileSync(visual, await storage.read(still ? job.data.lookUrl! : job.data.avatarUrl!));
    const audioExt = job.data.audioUrl!.split("?")[0].split(".").pop() || "mp3";
    const audio = path.join(dir, `voice.${audioExt}`);
    fs.writeFileSync(audio, await storage.read(job.data.audioUrl!));
    let music: string | undefined;
    if (s.musicUrl) {
      try {
        music = path.join(dir, "music.mp3");
        fs.writeFileSync(music, await storage.read(s.musicUrl));
      } catch (e) {
        music = undefined;
        log(job, "warn", `Background music unavailable: ${(e as Error).message}`);
      }
    }
    const sc = job.data.script!;
    const input = {
      workDir: dir, visualPath: visual, isStill: still, audioPath: audio, musicPath: music, musicVolume: s.musicVolume,
      words: job.data.words ?? [], hook: sc.onScreenHook, handle: s.handle, cta: sc.cta || s.ctaText,
      primary: s.primaryColor, accent: s.accentColor, text: s.textColor, thumbnailText: sc.thumbnailText,
    };
    let out: { videoPath: string; thumbPath: string; mode: string } | null = null;
    for (const prof of PROFILES) {
      try {
        out = await renderShort(input, prof);
        break;
      } catch (e) {
        log(job, "warn", `Render ${prof.name} failed: ${(e as Error).message.slice(0, 400)}`);
      }
    }
    if (!out && !still) {
      // Last resort: publish the raw talking-head with our audio — unbranded but on time.
      const raw = path.join(dir, "raw.mp4");
      await runFfmpeg(["-y", "-i", visual, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", raw]);
      const thumb = path.join(dir, "thumb.jpg");
      await runFfmpeg(["-y", "-ss", "1", "-i", visual, "-frames:v", "1", thumb]);
      out = { videoPath: raw, thumbPath: thumb, mode: "raw-fallback" };
      log(job, "warn", "Published raw avatar video without branding (editor failed)");
    }
    if (!out) throw new Error("Editing failed in every mode");
    job.data.videoUrl = await storage.put(`jobs/${job.id}/short.mp4`, fs.readFileSync(out.videoPath), "video/mp4");
    job.blobs.push(job.data.videoUrl);
    job.data.thumbnailUrl = await storage.put(`jobs/${job.id}/thumb.jpg`, fs.readFileSync(out.thumbPath), "image/jpeg");
    job.blobs.push(job.data.thumbnailUrl);
    job.data.editMode = out.mode;
    log(job, "info", `Edited (${out.mode}), ${(fs.statSync(out.videoPath).size / 1e6).toFixed(1)} MB`);
    return { next: "publish" };
  } finally {
    rmrf(dir);
  }
}

const MAX_PUBLISH_ATTEMPTS = 5;

async function publish(job: Job, s: BrandSettings): Promise<StageResult> {
  const storage = deps.storage();
  job.data.publish ??= {};
  const pub = job.data.publish;
  for (const p of job.platforms) {
    if (pub[p]) continue;
    if (job.publishMode === "private" && p !== "youtube") pub[p] = { state: "skipped", attempts: 0, error: "private test mode" };
    else if (await platformCapReached(p, s)) pub[p] = { state: "skipped", attempts: 0, error: `daily cap ${s.dailyPlatformCaps[p]} reached` };
    else pub[p] = { state: "pending", attempts: 0 };
  }
  let videoBuf: Promise<Buffer> | null = null;
  const input = {
    videoUrl: job.data.videoUrl!,
    thumbnailUrl: job.data.thumbnailUrl,
    readVideo: () => (videoBuf ??= storage.read(job.data.videoUrl!)),
    script: job.data.script!,
    story: job.data.story,
    settings: s,
    privateMode: job.publishMode === "private",
  };
  const due = job.platforms.filter((p) => {
    const r = pub[p]!;
    return (r.state === "pending" || r.state === "processing") && (!r.nextAttemptAt || new Date(r.nextAttemptAt) <= new Date());
  });
  await Promise.all(
    due.map(async (p) => {
      const prev = pub[p]!;
      try {
        const r = await deps.publishers[p].step(input, prev);
        pub[p] = r;
        if (r.state === "done") {
          await bumpDayCount(`post:${p}`, s.timezone);
          log(job, "info", `Published to ${p}: ${r.url}`);
        }
      } catch (e) {
        const err = e as Error & { resetPending?: boolean };
        const attempts = prev.attempts + 1;
        const permanent = e instanceof ReauthRequired || isPermanent(e);
        const failed = permanent || attempts >= MAX_PUBLISH_ATTEMPTS;
        pub[p] = {
          ...prev,
          attempts,
          state: failed ? "failed" : "pending",
          error: err.message.slice(0, 500),
          pending: err.resetPending ? undefined : prev.pending,
          nextAttemptAt: failed ? undefined : after(Math.min(1800, 60 * 2 ** (attempts - 1))),
        };
        log(job, failed ? "error" : "warn", `${p} ${failed ? "FAILED" : `attempt ${attempts} failed`}: ${err.message}`);
      }
    }),
  );
  const open = job.platforms.map((p) => pub[p]!).filter((r) => r.state === "pending" || r.state === "processing");
  if (!open.length) return { next: "cleanup" };
  const soonest = Math.min(...open.map((r) => (r.nextAttemptAt ? new Date(r.nextAttemptAt).getTime() : Date.now())));
  return { wait: Math.max(5, Math.round((soonest - Date.now()) / 1000)) };
}

async function cleanup(job: Job, s: BrandSettings): Promise<StageResult> {
  if (job.blobs.length) {
    try {
      await deps.storage().del(job.blobs);
      log(job, "info", `Deleted ${job.blobs.length} generated files`);
      job.blobs = [];
    } catch (e) {
      log(job, "warn", `Cleanup delete failed (will retry): ${(e as Error).message}`);
      throw e;
    }
  }
  const results = job.platforms.map((p) => job.data.publish?.[p]?.state);
  const attempted = results.filter((r) => r !== "skipped");
  const ok = results.filter((r) => r === "done").length;
  if (job.status !== "failed") job.status = ok > 0 && ok === attempted.length ? "done" : ok > 0 || attempted.length === 0 ? "partial" : "failed";
  job.finishedAt = new Date().toISOString();
  if (!job.sheetLogged) {
    await logRow("Runs", jobRow(job, s.timezone));
    job.sheetLogged = true;
  }
  return { next: "done" };
}

const STAGE_FNS: Record<Exclude<Stage, "done">, (j: Job, s: BrandSettings) => Promise<StageResult>> = {
  research, script, look, voice, avatar, edit, publish, cleanup,
};

/** Run exactly one stage of one job, with retry / fail bookkeeping. */
export async function stepJob(job: Job): Promise<Job> {
  if (job.stage === "done") return job;
  const s = await getSettings();
  const stage = job.stage;
  job.status = "running";
  try {
    const r = await STAGE_FNS[stage](job, s);
    if ("next" in r) {
      job.stage = r.next;
      job.stageAttempts = 0;
      job.nextAttemptAt = undefined;
      if (r.next !== "done") job.status = "running";
    } else {
      job.status = "waiting";
      job.nextAttemptAt = after(r.wait);
    }
  } catch (e) {
    job.stageAttempts++;
    const msg = (e as Error).message ?? String(e);
    log(job, "error", `${stage} attempt ${job.stageAttempts}/${MAX_ATTEMPTS[stage]}: ${msg}`);
    if (job.stageAttempts >= MAX_ATTEMPTS[stage]) {
      if (stage === "cleanup") {
        job.finishedAt = new Date().toISOString();
        job.stage = "done";
        if (!job.sheetLogged) await logRow("Runs", jobRow(job, s.timezone)).catch(() => undefined);
      } else {
        job.status = "failed";
        job.error = `${stage}: ${msg.slice(0, 300)}`;
        job.stage = "cleanup"; // still delete files + write the sheet row
        job.stageAttempts = 0;
        job.nextAttemptAt = undefined;
      }
    } else {
      job.status = "waiting";
      job.nextAttemptAt = after(Math.min(1800, 45 * 2 ** (job.stageAttempts - 1)));
    }
  }
  await saveJob(job);
  return job;
}

// ---------------------------- scheduling ----------------------------
function hourIn(tz: string, d = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d)) % 24;
}

export function isDue(s: Schedule, tz: string, active: Job[], now = new Date()): boolean {
  if (!s.enabled || !s.platforms.length) return false;
  if (active.some((j) => j.scheduleId === s.id)) return false;
  const h = hourIn(tz, now);
  const inWindow = s.windowStartHour <= s.windowEndHour ? h >= s.windowStartHour && h < s.windowEndHour : h >= s.windowStartHour || h < s.windowEndHour;
  if (s.windowStartHour !== s.windowEndHour && !inWindow) return false;
  if (!s.lastRunAt) return true;
  // 10-minute tolerance so an hourly schedule doesn't slip when the trigger is a bit early.
  return now.getTime() - new Date(s.lastRunAt).getTime() >= s.everyHours * 3600_000 - 10 * 60_000;
}

export async function createJob(s: Schedule, trigger: Job["trigger"], by: string): Promise<Job> {
  const st = await getSettings();
  const job = newJob(s, trigger, by);
  await bumpDayCount("videos", st.timezone);
  s.lastRunAt = new Date().toISOString();
  await saveSchedule(s);
  job.logs.push({ t: job.createdAt, stage: "research", level: "info", msg: `Job created (${trigger}) by ${by}` });
  await saveJob(job);
  return job;
}

export async function enqueueDue(): Promise<Job[]> {
  const s = await getSettings();
  const [schedules, active] = await Promise.all([listSchedules(), listActiveJobs()]);
  const created: Job[] = [];
  for (const sch of schedules) {
    if (active.length + created.length >= MAX_ACTIVE_JOBS) break;
    if (!isDue(sch, s.timezone, [...active, ...created])) continue;
    if ((await getDayCount("videos", s.timezone)) >= s.maxVideosPerDay) break;
    created.push(await createJob(sch, "cron", sch.createdBy));
  }
  return created;
}

export interface TickResult {
  status: "ok" | "busy";
  created: number;
  steps: number;
  activeJobs: number;
  /** seconds until the next job needs attention (null = idle) */
  nextWakeSec: number | null;
  flushed: number;
}

/** One worker pass: flush sheet buffer, enqueue due schedules, advance jobs until the time budget runs out. */
export async function tick(opts: { budgetSec?: number; enqueue?: boolean } = {}): Promise<TickResult> {
  const budgetMs = (opts.budgetSec ?? 270) * 1000;
  const t0 = Date.now();
  const kv = getKV();
  const lockId = `${t0}-${Math.random()}`;
  if (!(await kv.setNx("lock:tick", lockId, Math.ceil(budgetMs / 1000) + 30))) {
    return { status: "busy", created: 0, steps: 0, activeJobs: 0, nextWakeSec: null, flushed: 0 };
  }
  let steps = 0;
  let created = 0;
  let flushed = 0;
  try {
    flushed = await flushSheet().catch(() => 0);
    if (opts.enqueue !== false) created = (await enqueueDue()).length;
    for (;;) {
      const left = budgetMs - (Date.now() - t0);
      const jobs = (await listActiveJobs()).filter((j) => !j.nextAttemptAt || new Date(j.nextAttemptAt) <= new Date());
      const runnable = jobs.find((j) => left / 1000 >= (STAGE_BUDGET[j.stage] ?? 30));
      if (!runnable) break;
      await stepJob(runnable);
      steps++;
    }
  } finally {
    if ((await kv.get<string>("lock:tick")) === lockId) await kv.del("lock:tick");
  }
  const active = await listActiveJobs();
  const waits = active.map((j) => (j.nextAttemptAt ? Math.max(0, (new Date(j.nextAttemptAt).getTime() - Date.now()) / 1000) : 0));
  return { status: "ok", created, steps, activeJobs: active.length, nextWakeSec: waits.length ? Math.round(Math.min(...waits)) : null, flushed };
}

export function publishSummary(r?: Partial<Record<Platform, PublishResult>>) {
  return Object.entries(r ?? {}).map(([p, v]) => `${p}:${v?.state}`).join(" ");
}
