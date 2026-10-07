import { http, httpJson } from "../http";
import { sha } from "../crypto";
import type { Story } from "../types";

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

const strip = (s: string) => decodeEntities(decodeEntities(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function storyHash(title: string): string {
  return sha(title.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 10).join(" "));
}

export function parseRss(xml: string, sourceName: string): Story[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.map((it) => {
    const tag = (t: string) => strip(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(it)?.[1] ?? "");
    let title = tag("title");
    const src = tag("source") || sourceName;
    // Google News appends " - Publisher" to titles
    if (src && title.endsWith(` - ${src}`)) title = title.slice(0, -(src.length + 3));
    const traffic = tag("ht:approx_traffic");
    const newsTitle = tag("ht:news_item_title");
    return {
      title,
      url: tag("link") || tag("ht:news_item_url"),
      source: src,
      summary: [tag("description"), newsTitle, traffic && `search volume ${traffic}`].filter(Boolean).join(" — ").slice(0, 400),
      publishedAt: tag("pubDate") || undefined,
      hash: storyHash(title),
    };
  }).filter((s) => s.title.length > 8);
}

async function googleNews(query: string, lang: string): Promise<Story[]> {
  const gl = process.env.TRENDS_GEO || "IN";
  const hl = `${lang}-${gl}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:1d`)}&hl=${hl}&gl=${gl}&ceid=${gl}:${lang}`;
  const res = await http(url, { timeoutMs: 20_000, retries: 1, headers: { "User-Agent": "Mozilla/5.0 ShortsAutopilot" } });
  return parseRss(await res.text(), "Google News").slice(0, 20);
}

async function googleTrends(): Promise<Story[]> {
  const geo = process.env.TRENDS_GEO || "IN";
  const res = await http(`https://trends.google.com/trending/rss?geo=${geo}`, { timeoutMs: 20_000, retries: 1 });
  return parseRss(await res.text(), "Google Trends").slice(0, 20);
}

async function hackerNews(query: string): Promise<Story[]> {
  const since = Math.floor(Date.now() / 1000) - 36 * 3600;
  const r = await httpJson<{ hits: { title: string; url?: string; objectID: string; points: number; created_at: string }[] }>(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i>${since},points>40`,
    { timeoutMs: 15_000, retries: 1 },
  );
  return r.hits.slice(0, 15).map((h) => ({
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    source: "Hacker News",
    summary: `${h.points} points on Hacker News`,
    publishedAt: h.created_at,
    hash: storyHash(h.title),
  }));
}

export type TrendFetcher = (queries: string[], lang: string) => Promise<{ stories: Story[]; errors: string[] }>;

/** Gather fresh candidates from several free sources; any single source failing is fine. */
export const fetchTrends: TrendFetcher = async (queries, lang) => {
  const errors: string[] = [];
  const tasks: Promise<Story[]>[] = [];
  for (const q of queries.slice(0, 4)) {
    tasks.push(googleNews(q, lang));
    tasks.push(hackerNews(q));
  }
  tasks.push(googleTrends());
  const settled = await Promise.allSettled(tasks);
  const stories: Story[] = [];
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status === "rejected") {
      errors.push(String(s.reason?.message ?? s.reason).slice(0, 200));
      continue;
    }
    for (const st of s.value) {
      if (seen.has(st.hash)) continue;
      seen.add(st.hash);
      stories.push(st);
    }
  }
  return { stories, errors };
};
