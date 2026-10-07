import { describe, expect, it } from "vitest";
import { parseRss, storyHash } from "@/lib/ai/trends";
import { validateScript, cleanSpoken } from "@/lib/ai/prompts";
import { extractJson } from "@/lib/ai/llm";
import { assColor, buildOverlayAss, chunkWords, estimateWordTimings, wordsFromCharAlignment } from "@/lib/media/captions";
import { decrypt, encrypt } from "@/lib/crypto";
import { PLATFORMS } from "@/lib/types";

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>OpenAI launches GPT-6 for developers - The Verge</title><link>https://news.google.com/a</link><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate><description>&lt;a href="x"&gt;OpenAI launches&lt;/a&gt; something</description><source url="https://theverge.com">The Verge</source></item>
<item><title><![CDATA[India's AI mission gets ₹10,000 crore boost]]></title><link>https://news.google.com/b</link></item>
<item><title>short</title></item>
</channel></rss>`;

describe("trends", () => {
  it("parses Google News RSS and strips publisher suffix", () => {
    const s = parseRss(RSS, "Google News");
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ title: "OpenAI launches GPT-6 for developers", source: "The Verge", url: "https://news.google.com/a" });
    expect(s[0].summary).toBe("OpenAI launches something");
    expect(s[1].title).toContain("₹10,000");
  });
  it("hash is stable across punctuation / case", () => {
    expect(storyHash("OpenAI launches GPT-6!")).toBe(storyHash("openai launches gpt6"));
  });
});

describe("script validation", () => {
  const base = {
    hook: "x", onScreenHook: "y", title: "t", description: "d", hashtags: ["#AI", "Tech News"], thumbnailText: "T", cta: "c",
    captions: { youtube: "yt", x: "a".repeat(400) },
  };
  it("accepts a good script, fills missing captions, clamps X length, cleans hashtags", () => {
    const s = validateScript({ ...base, spoken: Array(100).fill("word").join(" ") }, 45);
    expect(s.captions.instagram).toBe("d");
    expect(s.captions.x.length).toBeLessThanOrEqual(275);
    expect(s.hashtags).toEqual(["AI", "TechNews"]);
    for (const p of PLATFORMS) expect(s.captions[p]).toBeTruthy();
  });
  it("rejects too short / too long", () => {
    expect(() => validateScript({ ...base, spoken: "too short" }, 45)).toThrow(/short/);
    expect(() => validateScript({ ...base, spoken: Array(400).fill("w").join(" ") }, 45)).toThrow(/long/);
  });
  it("strips emojis, urls, markdown from spoken text", () => {
    expect(cleanSpoken("Wow 🚀 check **this** https://x.com now #AI")).toBe("Wow check this now AI");
  });
  it("extracts JSON from fenced model output", () => {
    expect(extractJson<{ a: number }>("Sure!\n```json\n{\"a\": 1}\n```")).toEqual({ a: 1 });
  });
});

describe("captions", () => {
  it("ASS colour is BGR", () => {
    expect(assColor("#FFD60A")).toBe("&H000AD6FF");
  });
  it("char alignment -> words", () => {
    const chars = [..."Hi there"];
    const w = wordsFromCharAlignment(chars, chars.map((_, i) => i * 0.1), chars.map((_, i) => i * 0.1 + 0.1));
    expect(w.map((x) => x.word)).toEqual(["Hi", "there"]);
    expect(w[1].start).toBeCloseTo(0.3);
  });
  it("estimated timings cover the duration monotonically", () => {
    const w = estimateWordTimings("One two three. Four, five six seven", 10);
    expect(w).toHaveLength(7);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeGreaterThanOrEqual(w[i - 1].end);
    expect(w[w.length - 1].end).toBeLessThanOrEqual(10);
  });
  it("chunks break at punctuation and size", () => {
    const c = chunkWords(estimateWordTimings("AI is here. It will change everything you know about work", 8));
    expect(c[0].map((w) => w.word)).toEqual(["AI", "is", "here."]);
    expect(c.every((x) => x.length <= 3)).toBe(true);
  });
  it("overlay has hook, captions, handle, cta and escapes braces", () => {
    const ass = buildOverlayAss({ words: estimateWordTimings("a {b} c d e f g h i", 10), duration: 10, hook: "Big {news}", handle: "@me", cta: "Follow", primary: "#000000", accent: "#FFFF00", text: "#FFFFFF" });
    expect(ass).toContain("BIG NEWS");
    expect(ass).toMatch(/Style: Cap/);
    expect(ass).toContain(",Handle,,0,0,0,,@me");
    expect(ass).toContain("FOLLOW");
  });
});

describe("crypto", () => {
  it("round-trips and detects tampering", () => {
    const c = encrypt("secret-token");
    expect(decrypt(c)).toBe("secret-token");
    const parts = c.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
});
