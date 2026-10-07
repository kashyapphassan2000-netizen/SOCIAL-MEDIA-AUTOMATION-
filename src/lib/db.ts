import { getKV } from "./store/kv";
import { decrypt, encrypt, newId } from "./crypto";
import type { Assets, BrandSettings, Connection, Job, Platform, Schedule, User } from "./types";
import { PLATFORMS } from "./types";

const K = {
  user: (id: string) => `user:${id}`,
  users: "users",
  schedule: (id: string) => `schedule:${id}`,
  schedules: "schedules",
  job: (id: string) => `job:${id}`,
  jobsActive: "jobs:active",
  jobsRecent: "jobs:recent",
  settings: "settings:brand",
  assets: "settings:assets",
  conn: (p: string) => `conn:${p}`,
  usedStory: (scheduleId: string, hash: string) => `used:${scheduleId}:${hash}`,
  dayCount: (what: string, day: string) => `count:${what}:${day}`,
  sheetBuffer: "sheet:buffer",
  lookCursor: "looks:cursor",
};

/** Finished jobs are kept briefly for the dashboard; the Google Sheet is the permanent record. */
const FINISHED_JOB_TTL = 7 * 24 * 3600;

export const DEFAULT_SETTINGS: BrandSettings = {
  brandName: "My Brand",
  handle: "@myhandle",
  timezone: "Asia/Kolkata",
  primaryColor: "#0B1F3A",
  accentColor: "#FFD60A",
  textColor: "#FFFFFF",
  ctaText: "Follow for daily updates",
  looks: [
    { name: "Navy blazer", prompt: "wearing a tailored navy blazer over a plain white crew-neck t-shirt" },
    { name: "Black tee + specs", prompt: "wearing a fitted black crew-neck t-shirt and thin black rectangular glasses" },
    { name: "Olive overshirt", prompt: "wearing an olive green overshirt over a grey t-shirt" },
    { name: "White oxford", prompt: "wearing a crisp white oxford shirt, top button open" },
    { name: "Charcoal hoodie", prompt: "wearing a minimal charcoal grey hoodie, no logos" },
  ],
  generateLooks: true,
  // "clip" = lip-sync onto your real recorded clips (most natural); falls back to photo providers when no clip exists.
  avatarMode: "clip",
  allowGenericVoiceFallback: false,
  allowStillImageFallback: true,
  maxVideosPerDay: 6,
  dailyPlatformCaps: { youtube: 10, instagram: 20, facebook: 20, x: 20, threads: 20, linkedin: 3, pinterest: 10, bluesky: 20, telegram: 20 },
  youtubeCategoryId: "28",
  youtubePrivacy: "public",
  musicUrl: "",
  musicVolume: 0.08,
  // Free first; paid providers only kick in if their key is set (and the free path fails).
  avatarProviders: ["free-avatar", "fal-omnihuman", "fal-fabric", "still"],
  voiceProviders: ["free-voice", "elevenlabs", "fal-f5"],
  llmProviders: ["gemini", "groq", "cerebras", "openrouter", "nvidia", "anthropic", "openai"],
  sheetId: "",
  brandPromise: "",
  signature: "",
  brandHashtag: "",
  broll: true,
  punchIns: true,
  sfx: true,
  firstComment: true,
};

// ---------- users ----------
export async function listUsers(): Promise<User[]> {
  const kv = getKV();
  const ids = await kv.smembers(K.users);
  const users = await Promise.all(ids.map((id) => kv.get<User>(K.user(id))));
  return users.filter((u): u is User => !!u).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function findUserByEmail(email: string) {
  return (await listUsers()).find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
}
export async function saveUser(u: User) {
  const kv = getKV();
  await kv.set(K.user(u.id), u);
  await kv.sadd(K.users, u.id);
}
export async function deleteUser(id: string) {
  const kv = getKV();
  await kv.del(K.user(id));
  await kv.srem(K.users, id);
}

// ---------- schedules ----------
export async function listSchedules(): Promise<Schedule[]> {
  const kv = getKV();
  const ids = await kv.smembers(K.schedules);
  const all = await Promise.all(ids.map((id) => kv.get<Schedule>(K.schedule(id))));
  return all.filter((s): s is Schedule => !!s).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function getSchedule(id: string) {
  return getKV().get<Schedule>(K.schedule(id));
}
export async function saveSchedule(s: Schedule) {
  const kv = getKV();
  await kv.set(K.schedule(s.id), s);
  await kv.sadd(K.schedules, s.id);
}
export async function deleteSchedule(id: string) {
  const kv = getKV();
  await kv.del(K.schedule(id));
  await kv.srem(K.schedules, id);
}

// ---------- jobs ----------
export function newJob(s: Schedule, trigger: Job["trigger"], by: string): Job {
  const now = new Date().toISOString();
  return {
    id: newId("job"),
    scheduleId: s.id,
    scheduleName: s.name,
    topic: s.topic,
    createdBy: by,
    trigger,
    status: "queued",
    stage: "research",
    stageAttempts: 0,
    createdAt: now,
    updatedAt: now,
    platforms: s.platforms,
    publishMode: s.publishMode,
    data: {},
    blobs: [],
    logs: [],
  };
}
export async function getJob(id: string) {
  return getKV().get<Job>(K.job(id));
}
export async function saveJob(j: Job) {
  const kv = getKV();
  j.updatedAt = new Date().toISOString();
  if (j.logs.length > 120) j.logs = j.logs.slice(-120);
  const finished = j.stage === "done";
  await kv.set(K.job(j.id), j, finished ? { ttlSec: FINISHED_JOB_TTL } : undefined);
  if (finished) await kv.srem(K.jobsActive, j.id);
  else await kv.sadd(K.jobsActive, j.id);
  await kv.sadd(K.jobsRecent, j.id);
}
export async function listActiveJobs(): Promise<Job[]> {
  const kv = getKV();
  const ids = await kv.smembers(K.jobsActive);
  const jobs = await Promise.all(ids.map((id) => kv.get<Job>(K.job(id))));
  for (const [i, j] of jobs.entries()) if (!j) await kv.srem(K.jobsActive, ids[i]);
  return jobs.filter((j): j is Job => !!j).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function listRecentJobs(limit = 50): Promise<Job[]> {
  const kv = getKV();
  const ids = await kv.smembers(K.jobsRecent);
  const jobs = await Promise.all(ids.map((id) => kv.get<Job>(K.job(id))));
  for (const [i, j] of jobs.entries()) if (!j) await kv.srem(K.jobsRecent, ids[i]); // expired
  return jobs
    .filter((j): j is Job => !!j)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

// ---------- settings / assets ----------
export async function getSettings(): Promise<BrandSettings> {
  const s = await getKV().get<Partial<BrandSettings>>(K.settings);
  return {
    ...DEFAULT_SETTINGS,
    ...(s ?? {}),
    dailyPlatformCaps: { ...DEFAULT_SETTINGS.dailyPlatformCaps, ...(s?.dailyPlatformCaps ?? {}) },
  };
}
export async function saveSettings(s: BrandSettings) {
  await getKV().set(K.settings, s);
}
export async function getAssets(): Promise<Assets> {
  return (await getKV().get<Assets>(K.assets)) ?? {};
}
export async function saveAssets(a: Assets) {
  await getKV().set(K.assets, a);
}
export async function nextLookIndex(count: number): Promise<number> {
  const n = await getKV().incr(K.lookCursor);
  return count ? (n - 1) % count : 0;
}

// ---------- connections (tokens encrypted at rest) ----------
type StoredConn = Omit<Connection, "accessToken" | "refreshToken"> & { a?: string; r?: string };

export async function getConnection(p: Connection["platform"]): Promise<Connection | null> {
  const c = await getKV().get<StoredConn>(K.conn(p));
  if (!c) return null;
  const { a, r, ...rest } = c;
  return { ...rest, accessToken: a ? decrypt(a) : undefined, refreshToken: r ? decrypt(r) : undefined };
}
export async function saveConnection(c: Connection) {
  const { accessToken, refreshToken, ...rest } = c;
  const stored: StoredConn = {
    ...rest,
    updatedAt: new Date().toISOString(),
    a: accessToken ? encrypt(accessToken) : undefined,
    r: refreshToken ? encrypt(refreshToken) : undefined,
  };
  await getKV().set(K.conn(c.platform), stored);
}
export async function deleteConnection(p: Connection["platform"]) {
  await getKV().del(K.conn(p));
}
export async function listConnections(): Promise<Record<string, Omit<Connection, "accessToken" | "refreshToken"> | null>> {
  const out: Record<string, Omit<Connection, "accessToken" | "refreshToken"> | null> = {};
  for (const p of ["google", ...PLATFORMS] as const) {
    const c = await getConnection(p);
    out[p] = c ? { ...c, accessToken: undefined, refreshToken: undefined } as Connection : null;
  }
  return out;
}

// ---------- dedupe + counters ----------
export async function isStoryUsed(scheduleId: string, hash: string) {
  return (await getKV().get(K.usedStory(scheduleId, hash))) !== null;
}
export async function markStoryUsed(scheduleId: string, hash: string) {
  await getKV().set(K.usedStory(scheduleId, hash), 1, { ttlSec: 45 * 24 * 3600 });
}
export function dayKey(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export async function getDayCount(what: string, tz: string) {
  return Number((await getKV().get<number>(K.dayCount(what, dayKey(tz)))) ?? 0);
}
export async function bumpDayCount(what: string, tz: string) {
  return getKV().incr(K.dayCount(what, dayKey(tz)), 3 * 24 * 3600);
}
export async function platformCapReached(p: Platform, s: BrandSettings) {
  return (await getDayCount(`post:${p}`, s.timezone)) >= (s.dailyPlatformCaps[p] ?? 999);
}

export const keys = K;
