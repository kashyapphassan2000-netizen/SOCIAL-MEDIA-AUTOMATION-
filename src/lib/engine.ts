import fs from "node:fs";
import path from "node:path";
import { LLM_REGISTRY, generateJson, type LLM } from "./ai/llm";
import { loadCustomLLMs } from "./ai/custom";
import { WEBHOOK_MEDIA_HOLD_MIN } from "./outlets";
import { FACTCHECK_SYSTEM, PICK_SYSTEM, SCRIPT_SYSTEM, factcheckUser, pickUser, scriptUser, validateScript } from "./ai/prompts";
import { decodeEntities, enrichStory, fetchTrends, storyHash, type TrendFetcher } from "./ai/trends";
import { VOICE_REGISTRY, type VoiceProvider } from "./ai/voice";
import { AVATAR_REGISTRY, type AvatarProvider } from "./ai/avatar";
import { generateLook } from "./ai/looks";
import { PUBLISHERS, isPermanent, postFirstComment, type Publisher } from "./publishers";
import { ReauthRequired } from "./connections";
import { estimateWordTimings } from "./media/captions";
import { PROFILES, planPunchIns, renderShort } from "./media/editor";
import { findBroll, planCutaways, planScenes, type BrollFinder } from "./media/broll";
import { moodFor, seedFrom, snapToBeat, synthMusic, tempoOf } from "./media/music";
import { imageExt, probeDuration, rmrf, runFfmpeg, tmpDir } from "./media/ffmpeg";
import { getStorage, type Storage } from "./storage";
import { chooseHookStyle, collectStats, learnings, recordPublished } from "./insights";
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
  enrich: (story: Story) => Promise<Story>;
  publishers: Record<Platform, Publisher>;
  generateLook: typeof generateLook;
  storage: () => Storage;
  findBroll: BrollFinder;
  firstComment: typeof postFirstComment;
}

/**
 * Numbers the script states that appear nowhere in the source (title, summary, article text).
 * Small free models invent prices and percentages; a wrong number on a brand channel costs trust.
 */
export function ungroundedNumbers(spoken: string, story: Story, allowed = ""): string[] {
  const src = `${story.title} ${story.summary} ${story.details ?? ""} ${allowed}`.replace(/,(?=\d{3})/g, "");
  const nums = spoken.replace(/,(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/g) ?? [];
  const ok = new Set(src.match(/\d+(?:\.\d+)?/g) ?? []);
  // Small counting words ("2 things", "3 reasons") and the series episode are fine.
  return [...new Set(nums.filter((n) => !ok.has(n) && !(Number(n) <= 10 && !n.includes("."))))];
}

const pick = <T,>(reg: Record<string, T>, order: string[]) => order.map((n) => reg[n]).filter((x): x is T => !!x);

export const defaultDeps: Deps = {
  // The keyless provider is always appended last, so saved settings from before it existed still get it.
  // Plug-and-play providers (Settings → AI brain) not in the saved order still join, before the keyless fallback.
  llms: (s) => {
    const order = s.llmProviders.length ? s.llmProviders : Object.keys(LLM_REGISTRY).filter((k) => !k.startsWith("custom:"));
    const customs = Object.keys(LLM_REGISTRY).filter((k) => k.startsWith("custom:"));
    return pick(LLM_REGISTRY, [...new Set([...order, ...customs, "pollinations"])]);
  },
  voices: (s) => {
    const list = pick(VOICE_REGISTRY, s.voiceProviders);
    if (s.allowGenericVoiceFallback && !list.includes(VOICE_REGISTRY["openai-tts"])) list.push(VOICE_REGISTRY["openai-tts"]);
    return list;
  },
  // Clip mode puts the real-footage lip-sync providers first; photo providers remain as fallback.
  avatars: (s) => pick(AVATAR_REGISTRY, s.avatarMode === "clip" ? ["free-lipsync", "fal-lipsync-clip", ...s.avatarProviders] : s.avatarProviders),
  trends: fetchTrends,
  enrich: enrichStory,
  publishers: PUBLISHERS,
  generateLook,
  storage: getStorage,
  findBroll,
  firstComment: postFirstComment,
};

let deps: Deps = defaultDeps;
export function setDeps(d: Partial<Deps>) {
  deps = { ...defaultDeps, ...d };
}

// ------------------------------------------------------------------
type StageResult = { next: Stage } | { wait: number };

const MAX_ATTEMPTS: Record<Stage, number> = { research: 3, script: 3, look: 2, voice: 4, avatar: 6, broll: 2, edit: 3, publish: 1, cleanup: 5, done: 1 };
/** Seconds of function time a stage needs before we dare start it (Vercel kills at maxDuration). */
const STAGE_BUDGET: Partial<Record<Stage, number>> = { edit: 150, publish: 120, voice: 60, look: 60, script: 60, research: 40, broll: 70 };
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
  // A script written from a headline alone makes things up. If the pick has no readable article,
  // take the next fresh candidate that does (tried in list order, a few at most).
  let enriched = await deps.enrich(story);
  if (!enriched.details) {
    for (const alt of candidates.filter((c) => c.hash !== story.hash).slice(0, 4)) {
      const e = await deps.enrich(alt);
      if (!e.details) continue;
      log(job, "warn", `No article text for "${story.title}" — switched to "${alt.title}", which has a readable source`);
      await markStoryUsed(job.scheduleId, alt.hash);
      enriched = { ...e, angle: undefined };
      break;
    }
  }
  job.data.story = enriched;
  if (job.data.story.details) log(job, "info", `Read the article (${job.data.story.details.length} chars) to ground the script in real facts`);
  log(job, "info", `Picked (${provider}, score ${story.viralityScore ?? "?"}): ${story.title}`);
  return { next: "script" };
}

async function script(job: Job, s: BrandSettings): Promise<StageResult> {
  const sched = (await getSchedule(job.scheduleId)) ?? ({ id: job.scheduleId, topic: job.topic, instructions: "", language: "en", targetSeconds: 32 } as unknown as Schedule);
  const target = Math.min(58, Math.max(20, sched.targetSeconds || 32));
  const learned = await learnings(job.scheduleId).catch(() => null);
  const hookStyle = await chooseHookStyle(job.scheduleId, learned);
  // Episode number is committed only after a script succeeds (failed attempts must not skip numbers).
  const episode = sched.seriesName && sched.id ? (sched.episode ?? 0) + 1 : undefined;
  const { data, provider, errors } = await generateJson(
    deps.llms(s),
    SCRIPT_SYSTEM,
    scriptUser({ ...sched, targetSeconds: target }, job.data.story!, s, { hookStyle, episode, learnings: learned }),
    (v) => {
      const sc = validateScript(v, target);
      const invented = ungroundedNumbers(sc.spoken, job.data.story!, `${sched.seriesName ?? ""} ${episode ?? ""} ${s.signature} ${s.ctaText} ${s.brandPromise} ${target}`);
      if (invented.length) throw new Error(`invented numbers not in the source: ${invented.join(", ")} — remove them or use only numbers from the article text`);
      return sc;
    },
  );
  if (errors.length) log(job, "warn", `LLM retries: ${errors.join(" | ")}`);
  // Second pass: the script may only claim what the article says. One rewrite if it invented anything.
  const story = job.data.story!;
  if (story.details) {
    try {
      const fc = await generateJson(deps.llms(s), FACTCHECK_SYSTEM, factcheckUser(story.details, data.spoken), (v) => {
        const u = (v as { unsupported?: unknown }).unsupported;
        if (!Array.isArray(u)) throw new Error("unsupported[] missing");
        return u.map(String).filter(Boolean).slice(0, 8);
      });
      if (fc.data.length) {
        log(job, "warn", `Fact-check removed unsupported claims: ${fc.data.join(" | ").slice(0, 400)}`);
        const fixed = await generateJson(
          deps.llms(s),
          SCRIPT_SYSTEM,
          `${scriptUser({ ...sched, targetSeconds: target }, story, s, { hookStyle, episode, learnings: learned })}\n\nA fact-checker found claims NOT in the article. Rewrite without them (say less rather than guess): ${fc.data.join("; ")}`,
          (v) => validateScript(v, target),
        );
        Object.assign(data, fixed.data);
      }
    } catch (e) {
      log(job, "warn", `Fact-check skipped: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  for (const k of ["title", "hook", "spoken", "description", "onScreenHook", "thumbnailText", "pinnedComment"] as const) {
    if (typeof data[k] === "string") data[k] = decodeEntities(decodeEntities(data[k] as string)); // feeds sometimes double-encode (&amp;amp;)
  }
  if (episode !== undefined) {
    const fresh = await getSchedule(sched.id);
    if (fresh) await saveSchedule({ ...fresh, episode });
  }
  data.hookStyle = hookStyle;
  if (s.brandHashtag) {
    // Same brand tag on every post on every platform = searchable brand footprint.
    const tag = `#${s.brandHashtag}`;
    if (!data.hashtags.includes(s.brandHashtag)) data.hashtags = [s.brandHashtag, ...data.hashtags].slice(0, 10);
    const limit: Partial<Record<Platform, number>> = { x: 275, bluesky: 295, threads: 495, pinterest: 495 };
    for (const p of Object.keys(data.captions) as Platform[]) {
      if (data.captions[p].includes(tag)) continue;
      const next = `${data.captions[p]} ${tag}`;
      if (next.length <= (limit[p] ?? 2000)) data.captions[p] = next;
    }
  }
  job.data.script = data;
  log(job, "info", `Script by ${provider} [hook: ${hookStyle}${learned ? ", learning from past posts" : ""}]: "${data.title}" (${data.spoken.split(/\s+/).length} words)`);
  return { next: "look" };
}

async function look(job: Job, s: BrandSettings): Promise<StageResult> {
  const assets = await getAssets();
  const clips = assets.clips?.length ? assets.clips : assets.clipUrl ? [{ url: assets.clipUrl, name: "voice clip", addedAt: "" }] : [];
  if (s.avatarMode === "clip" && clips.length) {
    // Rotate your real clips (different outfits / places) — consistent face, varied look, zero AI artefacts on the body.
    const c = clips[await nextLookIndex(clips.length)];
    job.data.clipUrl = c.url;
    job.data.lookUrl = assets.photoUrl;
    job.data.lookName = `clip: ${c.name}`;
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
        if (img.length < 5_000) throw new Error(`generated image is broken (${img.length} bytes)`);
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

const VOICE_TIMEOUT_MIN = Number(process.env.FREE_VOICE_TIMEOUT_MIN || 60);

async function voice(job: Job, s: BrandSettings): Promise<StageResult> {
  const assets = await getAssets();
  const text = job.data.script!.spoken;
  const storage = deps.storage();
  const sched = await getSchedule(job.scheduleId);
  const ctx = {
    assets,
    language: sched?.language || "en",
    saveVoiceId: async (id: string) => saveAssets({ ...(await getAssets()), elevenVoiceId: id }),
    readSample: (u: string) => storage.read(u),
  };
  const providers = deps.voices(s).filter((v) => v.cloned || s.allowGenericVoiceFallback);

  const finish = async (name: string, cloned: boolean, audio: Buffer, ext: string, url?: string, words?: Job["data"]["words"]): Promise<StageResult> => {
    const dir = tmpDir();
    try {
      const f = path.join(dir, `voice.${ext}`);
      fs.writeFileSync(f, audio);
      job.data.audioSeconds = await probeDuration(f);
    } finally {
      rmrf(dir);
    }
    job.data.audioUrl = url ?? (await storage.put(`jobs/${job.id}/voice.${ext}`, audio, ext === "wav" ? "audio/wav" : "audio/mpeg"));
    job.blobs.push(job.data.audioUrl);
    job.data.words = words?.length ? words : estimateWordTimings(text, job.data.audioSeconds);
    job.data.voiceProvider = name + (cloned ? "" : " (generic)");
    job.data.voiceTask = undefined;
    if (!cloned) log(job, "warn", "Using a GENERIC voice (clone providers failed) — allowed by settings");
    log(job, "info", `Voice by ${name}: ${job.data.audioSeconds.toFixed(1)}s`);
    return { next: "avatar" };
  };

  // An async (self-hosted) voice task is in flight: poll it.
  const vt = job.data.voiceTask;
  if (vt) {
    const p = providers.find((x) => x.name === vt.provider);
    const r = p?.poll ? await p.poll(vt.taskId) : ({ state: "failed", error: "provider removed" } as const);
    if (r.state === "done") {
      const ext = r.url.split("?")[0].split(".").pop() || "mp3";
      return finish(r.engine ? `${vt.provider}/${r.engine}` : vt.provider, p!.cloned, await storage.read(r.url), ext, r.url, r.words);
    }
    const mins = (Date.now() - new Date(vt.submittedAt).getTime()) / 60000;
    if (r.state === "pending" && mins < VOICE_TIMEOUT_MIN) return { wait: 30 };
    log(job, "warn", r.state === "failed" ? `${vt.provider} failed: ${r.error}` : `${vt.provider} not done after ${mins.toFixed(0)} min — falling back`);
    job.data.voiceTask = undefined;
    job.data.voiceProviderIndex = (job.data.voiceProviderIndex ?? 0) + 1;
  }

  const errors: string[] = [];
  for (let i = job.data.voiceProviderIndex ?? 0; i < providers.length; i++) {
    const v = providers[i];
    job.data.voiceProviderIndex = i;
    if (!v.available(assets)) continue;
    try {
      if (v.submit) {
        const taskId = await v.submit(text, ctx);
        job.data.voiceTask = { provider: v.name, taskId, submittedAt: new Date().toISOString() };
        log(job, "info", `Queued voice clone on ${v.name} (free worker)`);
        return { wait: 60 };
      }
      const r = await v.synthesize(text, ctx);
      return await finish(v.name, v.cloned, r.audio, r.ext, undefined, r.words);
    } catch (e) {
      errors.push(`${v.name}: ${(e as Error).message.slice(0, 250)}`);
      log(job, "warn", `Voice provider ${v.name} failed: ${(e as Error).message}`);
    }
  }
  job.data.voiceProviderIndex = 0; // next attempt starts over from the preferred provider
  throw new Error(`No voice provider succeeded${errors.length ? "" : " (none configured: set up the free worker (WORKER_SECRET) or ELEVENLABS_API_KEY / FAL_KEY, and upload a voice clip)"}`);
}

async function avatar(job: Job, s: BrandSettings): Promise<StageResult> {
  const providers = deps.avatars(s).filter((p) => p.name !== "still" || s.allowStillImageFallback);
  const assets = await getAssets();
  const input = { imageUrl: job.data.lookUrl!, audioUrl: job.data.audioUrl!, clipUrl: job.data.clipUrl ?? assets.clipUrl, audioSeconds: job.data.audioSeconds ?? 0 };
  const req = job.data.avatar;
  if (req) {
    const p = providers.find((x) => x.name === req.provider);
    const res = p ? await p.poll(req) : ({ state: "failed", error: "provider removed" } as const);
    if (res.state === "pending") {
      const mins = (Date.now() - new Date(req.submittedAt).getTime()) / 60000;
      if (mins < (p?.timeoutMin ?? AVATAR_TIMEOUT_MIN)) return { wait: mins < 2 ? 40 : 30 };
      log(job, "warn", `${req.provider} still not done after ${mins.toFixed(0)} min — falling back`);
    } else if (res.state === "done") {
      job.data.avatarUrl = res.videoUrl;
      job.data.avatarProvider = req.provider;
      if (req.provider.startsWith("free-")) job.blobs.push(res.videoUrl); // stored in our Blob — delete after posting
      log(job, "info", `Avatar ready from ${req.provider}`);
      return { next: "broll" };
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
      return { next: "broll" };
    }
    try {
      job.data.avatar = await p.submit(input);
      log(job, "info", `Submitted talking-head render to ${p.name}`);
      return { wait: p.name.startsWith("free-") ? 120 : 60 };
    } catch (e) {
      log(job, "warn", `${p.name} submit failed: ${(e as Error).message}`);
    }
  }
  job.data.avatarProviderIndex = 0; // next attempt starts over from the best provider
  throw new Error("All avatar providers failed");
}

/** Fetch 2-3 relevant B-roll cutaways. Never fatal: a short without B-roll still ships. */
async function brollStage(job: Job, s: BrandSettings): Promise<StageResult> {
  const sc = job.data.script!;
  if (!sc.beats?.length || !job.data.words?.length) return { next: "edit" };
  const pip = (s.layout ?? "pip") === "pip";
  if (pip) {
    // Explainer layout: a scene per beat; stock visuals where available, branded animated cards otherwise.
    const scenes = planScenes(sc, job.data.words, job.data.audioSeconds ?? 0);
    job.data.scenes = scenes.map(({ start, end, point, query }) => ({ start, end, point, query }));
  }
  if (!s.broll) return { next: "edit" };
  const plan = pip ? (job.data.scenes ?? []) : planCutaways(sc, job.data.words, job.data.audioSeconds ?? 0);
  const storage = deps.storage();
  const got: NonNullable<Job["data"]["broll"]> = [];
  for (const c of plan) {
    try {
      const hit = await deps.findBroll(c.query);
      if (!hit) continue;
      const url = await storage.put(`jobs/${job.id}/broll-${got.length}.${hit.kind === "video" ? "mp4" : "jpg"}`, hit.buf, hit.kind === "video" ? "video/mp4" : "image/jpeg");
      job.blobs.push(url);
      got.push({ ...c, url, kind: hit.kind, source: hit.source });
    } catch (e) {
      log(job, "warn", `B-roll "${c.query}" failed: ${(e as Error).message}`);
    }
  }
  job.data.broll = got;
  log(job, "info", got.length ? `B-roll: ${got.map((g) => `${g.query} (${g.source}, ${g.start}-${g.end}s)`).join("; ")}` : "No B-roll used");
  return { next: "edit" };
}

async function edit(job: Job, s: BrandSettings): Promise<StageResult> {
  const storage = deps.storage();
  const dir = tmpDir();
  try {
    const still = !job.data.avatarUrl;
    const visualBuf = await storage.read(still ? job.data.lookUrl! : job.data.avatarUrl!);
    const visual = path.join(dir, still ? `visual.${imageExt(visualBuf)}` : "visual.mp4");
    fs.writeFileSync(visual, visualBuf);
    const audioExt = job.data.audioUrl!.split("?")[0].split(".").pop() || "mp3";
    const audio = path.join(dir, `voice.${audioExt}`);
    fs.writeFileSync(audio, await storage.read(job.data.audioUrl!));
    const music = await pickMusic(job, s, dir);
    // Cuts and zooms land on the beat when we know the tempo (our own generated track).
    const onBeat = (t: number) => (music?.bpm ? snapToBeat(t, music.bpm) : t);
    const sc = job.data.script!;
    const broll: { path: string; kind: "video" | "image"; start: number; end: number }[] = [];
    for (const [i, b] of (job.data.broll ?? []).entries()) {
      try {
        const p = path.join(dir, `broll-${i}.${b.kind === "video" ? "mp4" : "jpg"}`);
        fs.writeFileSync(p, await storage.read(b.url));
        const start = s.layout === "face" ? onBeat(b.start) : b.start; // explainer scenes must stay contiguous
        broll.push({ path: p, kind: b.kind, start, end: start + (b.end - b.start) });
      } catch {
        /* skip a missing cutaway */
      }
    }
    const words = job.data.words ?? [];
    const input = {
      workDir: dir, visualPath: visual, isStill: still, audioPath: audio, musicPath: music?.path, musicVolume: s.musicVolume, denoise: s.denoise,
      words, hook: sc.onScreenHook, handle: s.handle, cta: sc.cta || s.ctaText,
      primary: s.primaryColor, accent: s.accentColor, text: s.textColor, thumbnailText: sc.thumbnailText,
      broll, punchIns: s.punchIns && !still ? planPunchIns(words, job.data.audioSeconds ?? 0).map(([a, b]) => [onBeat(a), b] as [number, number]).filter(([a, b]) => b - a > 0.6) : [], sfx: s.sfx,
      emphasis: (sc.beats ?? []).map((b) => b.emphasis).filter(Boolean),
      layout: s.layout ?? "pip",
      scenes: job.data.scenes?.map((sc2) => ({ ...sc2, visual: broll.some((b) => b.start < sc2.end && b.end > sc2.start) })),
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
    job.data.videoUrl = await storage.put(`jobs/${job.id}/short.mp4`, fs.readFileSync(/*turbopackIgnore: true*/ out.videoPath), "video/mp4");
    job.blobs.push(job.data.videoUrl);
    job.data.thumbnailUrl = await storage.put(`jobs/${job.id}/thumb.jpg`, fs.readFileSync(/*turbopackIgnore: true*/ out.thumbPath), "image/jpeg");
    job.blobs.push(job.data.thumbnailUrl);
    job.data.editMode = out.mode;
    log(job, "info", `Edited (${out.mode}), ${(fs.statSync(/*turbopackIgnore: true*/ out.videoPath).size / 1e6).toFixed(1)} MB`);
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
    if (process.env.PUBLISH_HANDOFF) pub[p] = { state: "skipped", attempts: 0, error: "handed off to external publisher (EXPORT_DIR)" };
    else if (job.publishMode === "private" && p !== "youtube") pub[p] = { state: "skipped", attempts: 0, error: "private test mode" };
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
          if (s.firstComment && job.data.script?.pinnedComment && r.postId && (p === "youtube" || p === "instagram")) {
            await deps.firstComment(p, r.postId, job.data.script.pinnedComment)
              .then((ok) => ok && log(job, "info", `First comment posted on ${p}`))
              .catch((e) => log(job, "warn", `First comment on ${p} failed (reconnect to grant comment permission): ${(e as Error).message.slice(0, 160)}`));
          }
        }
      } catch (e) {
        const err = e as Error & { resetPending?: boolean; pendingOverride?: Record<string, string> };
        const attempts = prev.attempts + 1;
        const permanent = e instanceof ReauthRequired || isPermanent(e);
        const failed = permanent || attempts >= MAX_PUBLISH_ATTEMPTS;
        pub[p] = {
          ...prev,
          attempts,
          state: failed ? "failed" : "pending",
          error: err.message.slice(0, 500),
          pending: err.pendingOverride ?? (err.resetPending ? undefined : prev.pending),
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

/**
 * Hand the finished short to an outside publisher (e.g. a scheduled agent posting through connected accounts):
 * <EXPORT_DIR>/<jobId>/{video.mp4, thumbnail.jpg, post.json}. Runs before cleanup deletes the media.
 */
async function exportForHandoff(job: Job) {
  const dir = process.env.EXPORT_DIR;
  if (!dir || !job.data.videoUrl || !job.data.script) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const out = path.join(dir, job.id);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "video.mp4"), await deps.storage().read(job.data.videoUrl));
  if (job.data.thumbnailUrl) await fs.writeFile(path.join(out, "thumbnail.jpg"), await deps.storage().read(job.data.thumbnailUrl)).catch(() => undefined);
  const sc = job.data.script;
  await fs.writeFile(
    path.join(out, "post.json"),
    JSON.stringify({ jobId: job.id, topic: job.topic, story: job.data.story, title: sc.title, description: sc.description, hashtags: sc.hashtags, captions: sc.captions, pinnedComment: sc.pinnedComment, platforms: job.platforms, publishMode: job.publishMode }, null, 2),
  );
  log(job, "info", `Exported for publishing: ${out}`);
}

/**
 * Background music that can never cost you monetization:
 *  1. a fixed track URL you set (your responsibility), else
 *  2. your uploaded library (licensed tracks, rotated), else
 *  3. an ORIGINAL track generated for this video (claim-free by construction).
 */
/** The re-hook line ("But here's the part nobody's talking about") — where editors cut the music for impact. */
export function findReHook(words: { word: string; start: number; end: number }[], duration: number): { at: number; dur: number } | undefined {
  if (words.length < 8 || duration < 12) return undefined;
  const norm = words.map((w) => w.word.toLowerCase().replace(/[^a-z']/g, ""));
  for (let i = 0; i < norm.length - 2; i++) {
    const tri = `${norm[i]} ${norm[i + 1]} ${norm[i + 2]}`;
    if (/^(but here'?s|here'?s the|but wait|plot twist|here'?s what|but the real|the crazy part|nobody'?s talking|nobody is talking)/.test(tri) && words[i].start > duration * 0.25 && words[i].start < duration * 0.8) {
      let j = i;
      while (j < words.length - 1 && !/[.!?,]$/.test(words[j].word) && words[j].end - words[i].start < 3) j++;
      return { at: Math.max(0, words[i].start - 0.08), dur: Math.min(3, words[j].end - words[i].start + 0.15) };
    }
  }
  return undefined;
}

async function pickMusic(job: Job, s: BrandSettings, dir: string): Promise<{ path: string; bpm?: number } | undefined> {
  const mode = s.musicMode ?? "auto";
  if (mode === "off") return undefined;
  const storage = deps.storage();
  try {
    if (s.musicUrl) {
      const p = path.join(dir, "music.mp3");
      fs.writeFileSync(p, await storage.read(s.musicUrl));
      log(job, "info", "Music: your fixed track");
      return { path: p };
    }
    const lib = (await getAssets()).music ?? [];
    if (lib.length && mode !== "generated") {
      const t = lib[seedFrom(job.id) % lib.length];
      const p = path.join(dir, `music.${t.url.split("?")[0].split(".").pop() || "mp3"}`);
      fs.writeFileSync(p, await storage.read(t.url));
      log(job, "info", `Music: "${t.name}" from your library`);
      return { path: p };
    }
    if (mode === "library") return undefined;
    const p = path.join(dir, "music.wav");
    const mood = moodFor(job.data.script?.hookStyle);
    const drop = findReHook(job.data.words ?? [], job.data.audioSeconds ?? 0);
    fs.writeFileSync(p, synthMusic((job.data.audioSeconds ?? 35) + 1, seedFrom(job.id), mood, { drop }));
    const bpm = tempoOf(seedFrom(job.id), mood);
    log(job, "info", `Music: original ${mood} track at ${bpm} BPM${drop ? `, drops out for the re-hook at ${drop.at.toFixed(1)} s` : ""} (no copyright claims possible)`);
    return { path: p, bpm };
  } catch (e) {
    log(job, "warn", `Background music skipped: ${(e as Error).message}`);
    return undefined;
  }
}

async function cleanup(job: Job, s: BrandSettings): Promise<StageResult> {
  if (!job.exported) {
    await exportForHandoff(job);
    job.exported = true;
  }
  // Webhook receivers (Zapier, Make, n8n...) download the video after we call them — keep it available a while.
  const hookAt = job.data.publish?.webhook?.state === "done" ? job.data.publish.webhook.pending?.deliveredAt : undefined;
  if (hookAt && job.blobs.length) {
    const left = new Date(hookAt).getTime() + WEBHOOK_MEDIA_HOLD_MIN * 60_000 - Date.now();
    if (left > 0) return { wait: Math.min(1800, Math.ceil(left / 1000)) };
  }
  // Never lose a finished video: if it reached no platform, keep the final video + thumbnail for download.
  const delivered = Object.values(job.data.publish ?? {}).some((r) => r?.state === "done");
  const keep = !delivered && job.data.videoUrl ? [job.data.videoUrl, job.data.thumbnailUrl].filter((u): u is string => !!u) : [];
  if (keep.length && !job.keptForDownload) {
    job.keptForDownload = true;
    log(job, "warn", "No platform accepted this video — kept it for download in the dashboard (connect a platform to post automatically)");
  }
  const toDelete = job.blobs.filter((u) => !keep.includes(u));
  if (toDelete.length) {
    try {
      await deps.storage().del(toDelete);
      log(job, "info", `Deleted ${toDelete.length} generated files`);
      job.blobs = job.blobs.filter((u) => keep.includes(u));
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
  await recordPublished(job).catch(() => undefined);
  if (!job.sheetLogged) {
    await logRow("Runs", jobRow(job, s.timezone));
    job.sheetLogged = true;
  }
  return { next: "done" };
}

const STAGE_FNS: Record<Exclude<Stage, "done">, (j: Job, s: BrandSettings) => Promise<StageResult>> = {
  research, script, look, voice, avatar, broll: brollStage, edit, publish, cleanup,
};

/**
 * Self-healing: when a stage has used all its retries, take the next-best route instead of failing the job.
 * Each job has a recovery budget, so a genuinely broken setup still ends (and says why) instead of looping.
 */
const HEAL_BUDGET = 6;

/** Drop a cached AI look that broke a render, so the next video regenerates it instead of failing again. */
async function forgetLook(url: string) {
  const s = await getSettings();
  let changed = false;
  for (const l of s.looks) if (l.imageUrl === url) {
    l.imageUrl = undefined;
    changed = true;
  }
  if (changed) await saveSettings(s);
}
type Heal = { to: Stage; wait?: number; note: string; apply?: (j: Job) => void };
async function healFor(job: Job, stage: Stage): Promise<Heal | null> {
  const used = (job.heals ?? []).filter((h) => h.stage === stage).length;
  switch (stage) {
    case "research":
      return used < 3 ? { to: "research", wait: 600, note: "no usable story yet — looking at fresh news in 10 min" } : null;
    case "script":
      return used < 2 ? { to: "research", note: "the script kept failing — switching to a different trending story" } : null;
    case "look": {
      const photo = (await getAssets()).photoUrl;
      return photo ? { to: "voice", note: "outfit look failed — using your original photo", apply: (j) => (j.data.lookUrl = photo) } : null;
    }
    case "voice":
      return used < 2 ? { to: "voice", wait: 1800, note: "voice clone unavailable — retrying in 30 min (worker or quota outage)" } : null;
    case "avatar":
      return { to: "broll", note: "talking-head render failed — using your photo with gentle motion instead", apply: (j) => (j.data.avatarUrl = undefined) };
    case "broll":
      return { to: "edit", note: "stock visuals failed — using text scenes instead", apply: (j) => (j.data.broll = []) };
    case "edit": {
      // First: the safest inputs (original photo, no talking-head video) and forget a possibly broken AI look.
      const photo = (await getAssets()).photoUrl;
      if (used === 0 && photo && (job.data.lookUrl !== photo || job.data.avatarUrl)) {
        return {
          to: "edit",
          note: "render failed — retrying with your original photo",
          apply: (j) => {
            const bad = j.data.lookUrl;
            j.data.lookUrl = photo;
            j.data.avatarUrl = undefined;
            if (bad && bad !== photo) void forgetLook(bad);
          },
        };
      }
      return used < 3 ? { to: "edit", wait: 900, note: "render failed — retrying in 15 min" } : null;
    }
    default:
      return null;
  }
}

/** Run exactly one stage of one job, with retry / self-heal / fail bookkeeping. */
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
    const heal = job.stageAttempts >= MAX_ATTEMPTS[stage] && (job.heals?.length ?? 0) < HEAL_BUDGET ? await healFor(job, stage) : null;
    if (heal) {
      (job.heals ??= []).push({ stage, at: new Date().toISOString(), note: heal.note });
      log(job, "warn", `Self-heal: ${heal.note}`);
      heal.apply?.(job);
      job.stage = heal.to;
      job.stageAttempts = 0;
      job.status = heal.wait ? "waiting" : "running";
      job.nextAttemptAt = heal.wait ? after(heal.wait) : undefined;
    } else if (job.stageAttempts >= MAX_ATTEMPTS[stage]) {
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

/** Reasons the automation cannot produce a video at all — checked before spending the daily cap. */
export async function preflight(s: BrandSettings): Promise<string[]> {
  const a = await getAssets();
  const problems: string[] = [];
  if (!deps.llms(s).some((l) => l.available())) problems.push("no script AI key (free: GEMINI_API_KEY / GROQ_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY / NVIDIA_API_KEY)");
  if (!a.photoUrl) problems.push("no creator photo uploaded");
  if (!deps.voices(s).some((v) => v.available(a) && (v.cloned || s.allowGenericVoiceFallback))) problems.push("no usable voice (upload a voice clip + set WORKER_SECRET for the free worker, or ELEVENLABS_API_KEY / FAL_KEY)");
  return problems;
}

export async function enqueueDue(): Promise<Job[]> {
  const s = await getSettings();
  const problems = await preflight(s);
  if (problems.length) {
    await getKV().set("worker:blocked", { at: new Date().toISOString(), problems }, { ttlSec: 3 * 3600 });
    return [];
  }
  await getKV().del("worker:blocked");
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
  await loadCustomLLMs();
  if (!(await kv.setNx("lock:tick", lockId, Math.ceil(budgetMs / 1000) + 30))) {
    return { status: "busy", created: 0, steps: 0, activeJobs: 0, nextWakeSec: null, flushed: 0 };
  }
  let steps = 0;
  let created = 0;
  let flushed = 0;
  try {
    flushed = await flushSheet().catch(() => 0);
    // Pull real views/likes/comments for recent posts every 2 h (feeds the learning loop).
    if (await kv.setNx("perf:collect", "1", 2 * 3600)) await collectStats(await getSettings()).catch(() => 0);
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
