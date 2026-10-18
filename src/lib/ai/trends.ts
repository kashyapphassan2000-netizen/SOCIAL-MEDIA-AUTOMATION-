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

/** Atom feeds (<entry>, <link href>) — e.g. The Verge. */
export function parseAtom(xml: string, sourceName: string): Story[] {
  const items = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return items.map((it) => {
    const tag = (t: string) => strip(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(it)?.[1] ?? "");
    const title = tag("title");
    return {
      title,
      url: /<link[^>]*href="([^"]+)"/.exec(it)?.[1] ?? "",
      source: sourceName,
      summary: (tag("summary") || tag("content")).slice(0, 400),
      publishedAt: tag("published") || tag("updated") || undefined,
      hash: storyHash(title),
    };
  }).filter((s) => s.title.length > 8);
}

/** Publisher feeds carry direct article links (Google News links can't be opened server-side), so their stories can be fact-grounded. */
const AI_FEEDS = (process.env.AI_FEEDS || "https://techcrunch.com/category/artificial-intelligence/feed/,https://www.theverge.com/rss/ai-artificial-intelligence/index.xml,https://openai.com/news/rss.xml,https://blog.google/technology/ai/rss/")
  .split(",").map((u) => u.trim()).filter(Boolean);

async function publisherFeed(url: string): Promise<Story[]> {
  const res = await http(url, { timeoutMs: 20_000, retries: 1, headers: { "User-Agent": "Mozilla/5.0 ShortsAutopilot" } });
  const xml = await res.text();
  const name = new URL(url).hostname.replace(/^www\./, "");
  const all = xml.includes("<entry>") ? parseAtom(xml, name) : parseRss(xml, name);
  const since = Date.now() - 36 * 3600_000;
  return all.filter((s) => !s.publishedAt || new Date(s.publishedAt).getTime() > since).slice(0, 15);
}

/**
 * Pull the article text so the script is written from real facts, not just a headline (small free models
 * invent numbers when they only see a title). Best effort: paragraphs only, ~3,000 chars.
 */
export async function enrichStory(story: Story): Promise<Story> {
  // Google News links can't be opened server-side: find the same story's publisher pages via Bing News.
  const urls = /^https?:\/\//.test(story.url) && !/news\.google\.com/.test(story.url) ? [story.url] : [];
  if (!urls.length) urls.push(...(await articleLinks(story.title).catch(() => [] as string[])));
  for (const url of urls.slice(0, 4)) {
    const details = await articleText(url);
    if (details) return { ...story, details, url: story.url && !/news\.google\.com/.test(story.url) ? story.url : url };
  }
  return story;
}

async function articleText(url: string): Promise<string | null> {
  try {
    const res = await http(url, { timeoutMs: 15_000, retries: 0, headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortsAutopilot)" } });
    const html = (await res.text()).slice(0, 1_500_000);
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => strip(m[1])).filter((t) => t.length > 60);
    const details = paras.join(" ").slice(0, 3000);
    return details.length > 200 ? details : null;
  } catch {
    return null;
  }
}

/** Publisher links for a headline (Bing News RSS; its click-tracking links carry the target in ?url=). */
export async function articleLinks(title: string): Promise<string[]> {
  const res = await http(`https://www.bing.com/news/search?q=${encodeURIComponent(title.slice(0, 120))}&format=rss`, { timeoutMs: 15_000, retries: 1, headers: { "User-Agent": "Mozilla/5.0" } });
  const xml = await res.text();
  const out: string[] = [];
  for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const link = decodeEntities(/<link>([\s\S]*?)<\/link>/.exec(it)?.[1] ?? "");
    let target = link;
    try {
      target = new URL(link).searchParams.get("url") || link;
    } catch {
      continue;
    }
    if (/^https?:\/\//.test(target) && !/bing\.com|msn\.com/.test(new URL(target).hostname)) out.push(target);
  }
  return out;
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
  for (const f of AI_FEEDS) tasks.push(publisherFeed(f));
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
