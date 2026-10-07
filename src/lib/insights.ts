import { getKV } from "./store/kv";
import { googleAccessToken, metaToken } from "./connections";
import { httpJson } from "./http";
import { logRow, localTime } from "./sheets";
import { HOOK_STYLES, type Learnings } from "./ai/prompts";
import type { BrandSettings, Job, Platform } from "./types";

/**
 * Feedback loop: what actually performed → shapes the next scripts.
 * The algorithm cannot be "forced"; it rewards retention + engagement. This loop finds which hooks,
 * topics and titles YOUR audience rewards and leans into them (70% exploit / 30% explore).
 */
export interface PerfRecord {
  jobId: string;
  scheduleId: string;
  topic: string;
  title: string;
  hookStyle: string;
  publishedAt: string;
  posts: Partial<Record<Platform, string>>;
  stats?: { views: number; likes: number; comments: number; perPlatform: Partial<Record<Platform, number>>; at: string };
  finalLogged?: boolean;
}

const K = { rec: (id: string) => `perf:${id}`, index: "perf:index", learn: (sid: string) => `perf:learn:${sid}`, rr: (sid: string) => `perf:rr:${sid}` };
const TTL = 150 * 24 * 3600;

export async function recordPublished(job: Job) {
  const posts: PerfRecord["posts"] = {};
  for (const [p, r] of Object.entries(job.data.publish ?? {})) if (r?.state === "done" && r.postId) posts[p as Platform] = r.postId;
  if (!Object.keys(posts).length) return;
  const rec: PerfRecord = {
    jobId: job.id,
    scheduleId: job.scheduleId,
    topic: job.data.story?.title ?? job.topic,
    title: job.data.script?.title ?? "",
    hookStyle: job.data.script?.hookStyle ?? "unknown",
    publishedAt: new Date().toISOString(),
    posts,
  };
  const kv = getKV();
  await kv.set(K.rec(job.id), rec, { ttlSec: TTL });
  await kv.sadd(K.index, job.id);
}

async function allRecords(): Promise<PerfRecord[]> {
  const kv = getKV();
  const ids = await kv.smembers(K.index);
  const recs = await Promise.all(ids.map((id) => kv.get<PerfRecord>(K.rec(id))));
  for (const [i, r] of recs.entries()) if (!r) await kv.srem(K.index, ids[i]);
  return recs.filter((r): r is PerfRecord => !!r);
}

export type StatsFetcher = (recs: PerfRecord[]) => Promise<Map<string, Partial<Record<Platform, { views: number; likes: number; comments: number }>>>>;

/** Real platform numbers: YouTube statistics (batched, 1 quota unit per 50 videos) + Instagram insights. */
export const fetchStats: StatsFetcher = async (recs) => {
  const out = new Map<string, Partial<Record<Platform, { views: number; likes: number; comments: number }>>>();
  const yt = recs.filter((r) => r.posts.youtube);
  if (yt.length) {
    try {
      const token = await googleAccessToken();
      for (let i = 0; i < yt.length; i += 50) {
        const batch = yt.slice(i, i + 50);
        const r = await httpJson<{ items: { id: string; statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(
          `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch.map((b) => b.posts.youtube).join(",")}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        for (const it of r.items) {
          const rec = batch.find((b) => b.posts.youtube === it.id)!;
          out.set(rec.jobId, { ...(out.get(rec.jobId) ?? {}), youtube: { views: +(it.statistics.viewCount ?? 0), likes: +(it.statistics.likeCount ?? 0), comments: +(it.statistics.commentCount ?? 0) } });
        }
      }
    } catch {
      /* YouTube not connected — skip */
    }
  }
  const ig = recs.filter((r) => r.posts.instagram);
  if (ig.length) {
    try {
      const { token, host } = await metaToken("instagram");
      for (const rec of ig) {
        const r = await httpJson<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
          `${host}/${rec.posts.instagram}/insights?metric=views,likes,comments&access_token=${encodeURIComponent(token)}`,
        ).catch(() => null);
        if (!r) continue;
        const v = (n: string) => {
          const m = r.data.find((d) => d.name === n);
          return m?.total_value?.value ?? m?.values?.[0]?.value ?? 0;
        };
        out.set(rec.jobId, { ...(out.get(rec.jobId) ?? {}), instagram: { views: v("views"), likes: v("likes"), comments: v("comments") } });
      }
    } catch {
      /* Instagram not connected or insights scope missing */
    }
  }
  return out;
};

let fetcher: StatsFetcher = fetchStats;
export function setStatsFetcher(f: StatsFetcher | null) {
  fetcher = f ?? fetchStats;
}

/** Refresh stats for posts 20 h – 10 days old (at most every 12 h each); log a final row at 72 h. */
export async function collectStats(s: BrandSettings, now = Date.now()): Promise<number> {
  const kv = getKV();
  const recs = (await allRecords()).filter((r) => {
    const age = now - new Date(r.publishedAt).getTime();
    const fresh = r.stats && now - new Date(r.stats.at).getTime() < 12 * 3600_000;
    return age > 20 * 3600_000 && age < 10 * 24 * 3600_000 && !fresh;
  });
  if (!recs.length) return 0;
  const stats = await fetcher(recs);
  let n = 0;
  for (const r of recs) {
    const st = stats.get(r.jobId);
    if (!st) continue;
    const vals = Object.values(st);
    r.stats = {
      views: vals.reduce((a, b) => a + (b?.views ?? 0), 0),
      likes: vals.reduce((a, b) => a + (b?.likes ?? 0), 0),
      comments: vals.reduce((a, b) => a + (b?.comments ?? 0), 0),
      perPlatform: Object.fromEntries(Object.entries(st).map(([p, v]) => [p, v?.views ?? 0])),
      at: new Date(now).toISOString(),
    };
    if (!r.finalLogged && now - new Date(r.publishedAt).getTime() > 72 * 3600_000) {
      await logRow("Performance", [localTime(s.timezone, new Date(now)), r.jobId, r.title, r.hookStyle, String(r.stats.views), String(r.stats.likes), String(r.stats.comments), JSON.stringify(r.stats.perPlatform)]);
      r.finalLogged = true;
    }
    await kv.set(K.rec(r.jobId), r, { ttlSec: TTL });
    n++;
  }
  return n;
}

/** Turn the last ~40 measured posts into guidance for the writer. Needs >= 6 measured posts. */
export async function learnings(scheduleId?: string): Promise<Learnings | null> {
  const recs = (await allRecords()).filter((r) => r.stats && (!scheduleId || r.scheduleId === scheduleId)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 40);
  if (recs.length < 6) return null;
  const score = (r: PerfRecord) => r.stats!.views + 20 * r.stats!.comments + 5 * r.stats!.likes;
  const byStyle = new Map<string, number[]>();
  for (const r of recs) byStyle.set(r.hookStyle, [...(byStyle.get(r.hookStyle) ?? []), score(r)]);
  const styles = [...byStyle.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([k, v]) => ({ k, avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
    .sort((a, b) => b.avg - a.avg);
  const sorted = [...recs].sort((a, b) => score(b) - score(a));
  const median = score(sorted[Math.floor(sorted.length / 2)]);
  return {
    bestHookStyles: styles.slice(0, 2).map((s) => s.k),
    topTitles: sorted.slice(0, 3).map((r) => r.title),
    weakTitles: sorted.slice(-3).map((r) => r.title),
    summary: [
      `Measured posts: ${recs.length}; median engagement score ${Math.round(median)}.`,
      styles.length ? `Hook styles ranked: ${styles.map((s) => `${s.k} (${Math.round(s.avg)}, n=${s.n})`).join(", ")}.` : "",
      `Best topics: ${sorted.slice(0, 3).map((r) => r.topic).join(" | ")}.`,
    ].filter(Boolean).join(" "),
  };
}

/** 70% the best-performing hook style, 30% exploration (round-robin) — never stuck on one format. */
export async function chooseHookStyle(scheduleId: string, l: Learnings | null, rand = Math.random()): Promise<string> {
  const all = Object.keys(HOOK_STYLES);
  // 50% the winner, 20% the runner-up, 30% explore the rest.
  if (l?.bestHookStyles.length && rand < 0.7) return rand < 0.5 || l.bestHookStyles.length < 2 ? l.bestHookStyles[0] : l.bestHookStyles[1];
  const n = await getKV().incr(K.rr(scheduleId));
  return all[(n - 1) % all.length];
}
