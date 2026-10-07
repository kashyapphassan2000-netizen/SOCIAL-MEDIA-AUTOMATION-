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

export const SCRIPT_SYSTEM = `You are the head writer of a personal-brand short-form channel (YouTube Shorts, Reels, X, Threads, LinkedIn, Pinterest, Bluesky, Telegram).
The creator appears on camera and speaks your script in first person with their own cloned voice. Your job: maximise RETENTION and make viewers remember the creator's name and series.

Retention structure (non-negotiable):
1. 0-2 s HOOK: one sentence, max 10 words, in the requested hook style. It must create an open loop. No "Hey guys", no "In this video", no throat-clearing.
2. 2-8 s STAKES: why THIS viewer should care right now ("If you use X...", "This means your job...").
3. Middle: 2-3 BEATS, each one short concrete fact or insight. Every 3-5 seconds something new happens. Halfway, add a re-hook ("But here's the part nobody is talking about").
4. PAYOFF: the creator's own opinion / prediction — original commentary is what keeps the channel monetisable under "inauthentic / reused content" rules.
5. LOOP ENDING: the last sentence should flow naturally back into the first line when the short replays, OR end with a pointed question that begs a comment. Then the sign-off.

Voice: spoken, punchy, contractions, one idea per sentence, sounds like a smart friend not a news anchor. Plain words only in "spoken": no emojis, hashtags, URLs, brackets, stage directions, markdown. Write numbers as they are said.
Truth: only facts in the source; "reportedly" for anything unconfirmed; never invent numbers, quotes or dates.
Advertiser-friendly: no profanity, shock, hate, medical/financial/legal advice, or misleading clickbait (the title must be delivered on by the video).
Respond with JSON only.`;

/** Proven hook frameworks; the engine rotates them and learns which ones your audience rewards. */
export const HOOK_STYLES: Record<string, string> = {
  contrarian: "Contrarian: challenge a popular belief (\"Everyone is wrong about X.\")",
  number: "Specific number / stat that surprises (\"97% of people never…\")",
  you: "Direct 'you' consequence (\"Your job just changed and nobody told you.\")",
  curiosity: "Curiosity gap (\"This tiny update is bigger than it looks.\")",
  warning: "Warning / mistake (\"Stop doing X before this happens.\")",
  breaking: "Breaking-news urgency (\"This dropped 3 hours ago and it changes X.\")",
  story: "Micro-story in one line (\"Yesterday a 19-year-old beat Google at…\")",
};

export interface Learnings {
  summary: string;
  bestHookStyles: string[];
  topTitles: string[];
  weakTitles: string[];
}

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

export function scriptUser(s: Schedule, story: Story, brand: BrandSettings, ctx: { hookStyle: string; episode?: number; learnings?: Learnings | null }): string {
  const words = Math.round(s.targetSeconds * 2.6);
  const series = s.seriesName ? `${s.seriesName}${ctx.episode ? ` #${ctx.episode}` : ""}` : "";
  const learn = ctx.learnings
    ? `\nWhat this audience rewarded recently (use it, don't copy it):\n${ctx.learnings.summary}\nTop titles: ${ctx.learnings.topTitles.join(" | ") || "n/a"}\nWeak titles (avoid their pattern): ${ctx.learnings.weakTitles.join(" | ") || "n/a"}\n`
    : "";
  return `Creator brand: ${brand.brandName} (${brand.handle}). Brand promise: ${brand.brandPromise || "smart, fast, practical takes"}.
${series ? `Recurring series: "${series}" — the title MUST start with "${series}: ". Viewers should recognise the format instantly.` : ""}
Niche: ${s.topic}
Owner direction: ${s.instructions || "(none)"}
Language of speech and captions: ${s.language}
Target length: ${s.targetSeconds} seconds ≈ ${words} spoken words (hard min ${Math.round(words * 0.85)}, hard max ${Math.round(words * 1.15)}). Shorts that keep people to the end beat longer ones.
Hook style for THIS video: ${HOOK_STYLES[ctx.hookStyle] ?? ctx.hookStyle}
Sign-off (use as the very last sentence, verbatim): "${brand.signature || brand.ctaText}"
${learn}
Story: ${story.title}
Source: ${story.source} ${story.url}
Details: ${story.summary || "(headline only — do not invent specifics)"}
Angle to take: ${story.angle || "your call"}

Return JSON:
{
  "hook": "first spoken sentence (max 10 words)",
  "spoken": "the full spoken script INCLUDING the hook first and the sign-off last",
  "beats": [{"text": "the exact sentence(s) from spoken for this beat", "broll": "2-4 word stock-footage search query that visually illustrates it (concrete nouns, no text)", "emphasis": "ONE key word from this beat to highlight on screen"}],
  "onScreenHook": "2-6 word on-screen text for the first 3 seconds (complements, not repeats, the spoken hook)",
  "title": "max 70 chars, curiosity + searchable keyword, delivered on by the video",
  "description": "generic 1-2 sentence description",
  "hashtags": ["5-8 relevant hashtags without #"],
  "thumbnailText": "2-4 punchy words",
  "cta": "4-7 word end-card text",
  "pinnedComment": "a first comment from the creator: a sharp question or poll-style prompt that makes people reply",
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
  const maxWords = Math.round(targetSeconds * 2.6 * 1.3);
  const minWords = Math.max(25, Math.round(targetSeconds * 2.6 * 0.7));
  if (wordCount < minWords) throw new Error(`script too short (${wordCount} words < ${minWords})`);
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
    beats: Array.isArray(o.beats)
      ? o.beats
          .filter((b: any) => b && typeof b.text === "string")
          .slice(0, 6)
          .map((b: any) => ({ text: cleanSpoken(String(b.text)), broll: String(b.broll ?? "").slice(0, 60), emphasis: String(b.emphasis ?? "").replace(/[^\p{L}\p{N}'-]/gu, "").slice(0, 24) }))
      : [],
    pinnedComment: typeof o.pinnedComment === "string" ? o.pinnedComment.trim().slice(0, 300) : undefined,
  };
}
