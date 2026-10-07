import type { BrandSettings, Platform, Schedule, Script, Story } from "../types";
import { PLATFORMS } from "../types";

export const PICK_SYSTEM = `You are the head of content for a fast-growing short-form video brand.
You pick the ONE story most likely to go viral as a 30-60 second talking-head short today.
Score candidates on: novelty (broke in last 24h), mass relevance to the niche audience, emotional pull (surprise, fear of missing out, money, jobs, "this changes X"), clarity in under 60 seconds, and comment-bait potential.
Reject: tragedies/deaths, politics-of-hate, medical or financial advice, rumours with no source, anything that would be demonetised (violence, adult, shock).
Respond with JSON only.`;

export function pickUser(s: Schedule, candidates: Story[]): string {
  const list = candidates.map((c, i) => `${i}. ${c.title} [${c.source}] ${c.summary ? `— ${c.summary.slice(0, 220)}` : ""}`).join("\n");
  return `Niche: ${s.topic}
Owner direction: ${s.instructions || "(none)"}
Audience language: ${s.language}

Candidates:
${list || "(no fresh news available)"}

If no candidate fits the niche, set "index": -1 and propose an evergreen high-value idea in "evergreen" (a concrete tip, tool, myth-buster or prediction in the niche).

Return: {"index": number, "viralityScore": 1-100, "angle": "the specific take that makes it shareable", "why": "one sentence", "evergreen": {"title": "...", "summary": "..."} | null}`;
}

export const SCRIPT_SYSTEM = `You write scripts for a personal-brand short-form video channel (YouTube Shorts, Instagram Reels, Facebook Reels, X, Threads, LinkedIn).
The creator appears on camera as a talking head and speaks the script in first person with their own cloned voice.

Rules that protect reach AND monetisation:
- Hook in the first sentence (under 12 words): a surprising claim, number, or "you" statement. No "Hey guys", no "In this video".
- Add the creator's own opinion/analysis — never just read the news. Original commentary is what keeps the channel monetisable under "inauthentic / reused content" policies.
- Stick to facts present in the source. If something is unconfirmed say "reportedly". Never invent numbers, quotes or dates.
- Advertiser-friendly: no profanity, no shock, no medical/financial/legal advice, no hate, no misleading clickbait.
- Short punchy sentences, spoken style, contractions. One idea per sentence. End with a question or a loop line that drives comments, then a 4-7 word follow call-to-action.
- Spoken text must be plain words only: no emojis, hashtags, URLs, stage directions, brackets or markdown. Write numbers the way they are said.
- Platform captions: native to each platform, disclose nothing false, include the source name for credit.
Respond with JSON only.`;

const CAPTION_RULES: Record<Platform, string> = {
  youtube: "YouTube description: 2-3 lines of context, source credit line, 3-5 hashtags incl #Shorts (max 900 chars)",
  instagram: "Instagram caption: hook line, 2-3 short value lines, CTA to follow, then 5-8 niche hashtags (max 1800 chars)",
  facebook: "Facebook caption: conversational 2-4 lines, question to drive comments, 2-3 hashtags (max 1200 chars)",
  x: "X post: max 240 characters total including 1-2 hashtags, punchy, no links",
  threads: "Threads post: max 430 characters, conversational, ends with a question, at most 1 hashtag",
  linkedin: "LinkedIn post: professional insight, why it matters for careers/business, 3-6 short lines, 3 hashtags (max 1300 chars)",
  pinterest: "Pinterest description: keyword-rich, searchable (Pinterest is a search engine), 2-3 sentences, 3-5 hashtags (max 450 chars)",
  bluesky: "Bluesky post: max 280 characters total, conversational, 1-2 hashtags",
  telegram: "Telegram channel post: bold-free plain text, 2-4 short lines with the key takeaway and source credit (max 900 chars)",
};

export function scriptUser(s: Schedule, story: Story, brand: BrandSettings): string {
  const words = Math.round(s.targetSeconds * 2.5);
  return `Creator brand: ${brand.brandName} (${brand.handle})
Niche: ${s.topic}
Owner direction: ${s.instructions || "(none)"}
Language of speech and captions: ${s.language}
Target length: ${s.targetSeconds} seconds ≈ ${words} spoken words (hard max ${Math.round(words * 1.15)} words).

Story: ${story.title}
Source: ${story.source} ${story.url}
Details: ${story.summary || "(headline only — do not invent specifics)"}
Angle to take: ${story.angle || "your call"}

Return JSON:
{
  "hook": "first spoken sentence",
  "spoken": "the full spoken script INCLUDING the hook as first sentence and CTA as last",
  "onScreenHook": "2-6 word on-screen text for the first 3 seconds",
  "title": "max 70 chars, curiosity + keyword, no clickbait lies",
  "description": "generic 1-2 sentence description",
  "hashtags": ["5-8 relevant hashtags without #"],
  "thumbnailText": "2-4 punchy words",
  "cta": "4-7 word follow call to action for the end card",
  "captions": {${PLATFORMS.map((p) => `\n    "${p}": "${CAPTION_RULES[p]}"`).join(",")}
  }
}`;
}

const str = (v: unknown, name: string, max = 5000): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`script.${name} missing`);
  return v.trim().slice(0, max);
};

export function cleanSpoken(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_`~>\[\]{}()]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateScript(v: unknown, targetSeconds: number): Script {
  const o = v as Record<string, any>;
  const spoken = cleanSpoken(str(o.spoken, "spoken"));
  const wordCount = spoken.split(/\s+/).length;
  const maxWords = Math.round(targetSeconds * 2.5 * 1.35);
  if (wordCount < 25) throw new Error(`script too short (${wordCount} words)`);
  if (wordCount > maxWords) throw new Error(`script too long (${wordCount} words > ${maxWords})`);
  const caps = (o.captions ?? {}) as Record<string, unknown>;
  const captions = {} as Record<Platform, string>;
  const fallback = str(o.description, "description", 1000);
  for (const p of PLATFORMS) captions[p] = typeof caps[p] === "string" && (caps[p] as string).trim() ? (caps[p] as string).trim() : fallback;
  captions.x = captions.x.slice(0, 275);
  captions.threads = captions.threads.slice(0, 495);
  captions.bluesky = captions.bluesky.slice(0, 295);
  captions.pinterest = captions.pinterest.slice(0, 495);
  captions.telegram = captions.telegram.slice(0, 1000);
  const hashtags = Array.isArray(o.hashtags) ? o.hashtags.map((h: unknown) => String(h).replace(/^#/, "").replace(/\s+/g, "")).filter(Boolean).slice(0, 10) : [];
  return {
    hook: str(o.hook, "hook", 200),
    spoken,
    onScreenHook: str(o.onScreenHook, "onScreenHook", 60),
    title: str(o.title, "title", 95),
    description: fallback,
    hashtags,
    captions,
    thumbnailText: str(o.thumbnailText ?? o.onScreenHook, "thumbnailText", 40),
    cta: str(o.cta ?? "Follow for more", "cta", 60),
  };
}
