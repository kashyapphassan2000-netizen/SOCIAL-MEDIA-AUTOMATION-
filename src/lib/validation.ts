import { z } from "zod";
import { PLATFORMS } from "./types";

export const scheduleInput = z.object({
  name: z.string().trim().min(1).max(80),
  topic: z.string().trim().min(2).max(200),
  instructions: z.string().max(2000).default(""),
  queries: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
  language: z.string().trim().min(2).max(10).default("en"),
  everyHours: z.number().int().min(1).max(168).default(1),
  windowStartHour: z.number().int().min(0).max(23).default(0),
  windowEndHour: z.number().int().min(0).max(23).default(0),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
  // 28-35 s is the retention sweet spot for Shorts/Reels; allowed 20-58.
  targetSeconds: z.number().int().min(20).max(58).default(32),
  seriesName: z.string().trim().max(40).optional(),
  publishMode: z.enum(["live", "private"]).default("live"),
  enabled: z.boolean().default(true),
});

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const settingsInput = z.object({
  brandName: z.string().trim().min(1).max(80),
  handle: z.string().trim().max(60),
  timezone: z.string().trim().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone"),
  primaryColor: hex,
  accentColor: hex,
  textColor: hex,
  ctaText: z.string().max(80),
  looks: z.array(z.object({ name: z.string().trim().min(1).max(40), prompt: z.string().trim().min(3).max(300), imageUrl: z.string().optional() })).max(20),
  generateLooks: z.boolean(),
  avatarMode: z.enum(["photo", "clip"]),
  allowGenericVoiceFallback: z.boolean(),
  allowStillImageFallback: z.boolean(),
  maxVideosPerDay: z.number().int().min(0).max(100),
  dailyPlatformCaps: z.record(z.enum(PLATFORMS), z.number().int().min(0).max(100)),
  youtubeCategoryId: z.string().regex(/^\d+$/),
  youtubePrivacy: z.enum(["public", "unlisted", "private"]),
  musicUrl: z.string().max(500),
  musicVolume: z.number().min(0).max(1),
  avatarProviders: z.array(z.string()).min(1),
  voiceProviders: z.array(z.string()).min(1),
  llmProviders: z.array(z.string()).min(1),
  sheetId: z.string().trim().max(200),
  brandPromise: z.string().trim().max(200).default(""),
  signature: z.string().trim().max(120).default(""),
  brandHashtag: z.string().trim().max(40).regex(/^[\p{L}\p{N}_]*$/u, "letters/numbers only, no #").default(""),
  broll: z.boolean().default(true),
  punchIns: z.boolean().default(true),
  sfx: z.boolean().default(true),
  firstComment: z.boolean().default(true),
});

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw Object.assign(new Error(msg), { status: 400 });
  }
  return r.data;
}
