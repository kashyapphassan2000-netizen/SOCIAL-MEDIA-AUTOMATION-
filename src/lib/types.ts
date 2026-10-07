export const PLATFORMS = ["youtube", "instagram", "facebook", "x", "threads", "linkedin"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube Shorts",
  instagram: "Instagram Reels",
  facebook: "Facebook Reels",
  x: "X (Twitter)",
  threads: "Threads",
  linkedin: "LinkedIn",
};

export type Role = "owner" | "user";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
  createdAt: string;
  createdBy: string;
}

export interface Session {
  uid: string;
  email: string;
  name: string;
  role: Role;
}

/** A recurring content recipe ("post AI news every hour"). */
export interface Schedule {
  id: string;
  name: string;
  /** Niche / topic the user wants to own, e.g. "AI news". */
  topic: string;
  /** Free-text direction: angle, audience, do / don't. */
  instructions: string;
  /** Extra search queries for trend research (defaults to the topic). */
  queries: string[];
  language: string;
  /** Run every N hours (1 = hourly). */
  everyHours: number;
  /** Optional posting window in the brand timezone, inclusive start / exclusive end hour. */
  windowStartHour: number;
  windowEndHour: number;
  platforms: Platform[];
  /** Target spoken length in seconds (shorts sweet spot: 30-55). */
  targetSeconds: number;
  /** "live" publishes publicly. "private" = YouTube private only, other platforms skipped (safe test). */
  publishMode: "live" | "private";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export type Stage =
  | "research"
  | "script"
  | "look"
  | "voice"
  | "avatar"
  | "edit"
  | "publish"
  | "cleanup"
  | "done";

export const STAGES: Stage[] = ["research", "script", "look", "voice", "avatar", "edit", "publish", "cleanup", "done"];

export type JobStatus = "queued" | "running" | "waiting" | "done" | "partial" | "failed";

export interface Story {
  title: string;
  url: string;
  source: string;
  summary: string;
  publishedAt?: string;
  hash: string;
  viralityScore?: number;
  angle?: string;
}

export interface Script {
  hook: string;
  spoken: string;
  onScreenHook: string;
  title: string;
  description: string;
  hashtags: string[];
  captions: Record<Platform, string>;
  thumbnailText: string;
  cta: string;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface AvatarRequest {
  provider: string;
  requestId: string;
  statusUrl?: string;
  responseUrl?: string;
  submittedAt: string;
}

export type PublishState = "pending" | "processing" | "done" | "failed" | "skipped";

export interface PublishResult {
  state: PublishState;
  attempts: number;
  /** Platform-side id of the finished post. */
  postId?: string;
  url?: string;
  error?: string;
  /** Opaque in-progress data (container ids, media ids, upload tokens). */
  pending?: Record<string, string>;
  nextAttemptAt?: string;
}

export interface JobLog {
  t: string;
  stage: Stage;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface Job {
  id: string;
  scheduleId: string;
  scheduleName: string;
  topic: string;
  createdBy: string;
  trigger: "cron" | "manual";
  status: JobStatus;
  stage: Stage;
  stageAttempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
  platforms: Platform[];
  publishMode: "live" | "private";
  data: {
    story?: Story;
    script?: Script;
    lookUrl?: string;
    lookName?: string;
    audioUrl?: string;
    audioSeconds?: number;
    voiceProvider?: string;
    words?: WordTiming[];
    avatarProviderIndex?: number;
    avatar?: AvatarRequest;
    avatarUrl?: string;
    avatarProvider?: string;
    videoUrl?: string;
    thumbnailUrl?: string;
    editMode?: string;
    publish?: Partial<Record<Platform, PublishResult>>;
  };
  /** Generated blobs to delete after publishing. */
  blobs: string[];
  logs: JobLog[];
  sheetLogged?: boolean;
}

export interface Look {
  name: string;
  prompt: string;
  imageUrl?: string;
}

export interface BrandSettings {
  brandName: string;
  handle: string;
  timezone: string;
  primaryColor: string;
  accentColor: string;
  textColor: string;
  ctaText: string;
  /** Rotating outfit / style variations generated from the base photo. */
  looks: Look[];
  generateLooks: boolean;
  avatarMode: "photo" | "clip";
  allowGenericVoiceFallback: boolean;
  allowStillImageFallback: boolean;
  /** Global safety fuse: max videos generated per day across all schedules. */
  maxVideosPerDay: number;
  dailyPlatformCaps: Record<Platform, number>;
  youtubeCategoryId: string;
  youtubePrivacy: "public" | "unlisted" | "private";
  musicUrl: string;
  musicVolume: number;
  avatarProviders: string[];
  voiceProviders: string[];
  llmProviders: string[];
  /** Google Sheet id for the run log (falls back to GOOGLE_SHEET_ID env). */
  sheetId: string;
}

export interface Assets {
  photoUrl?: string;
  clipUrl?: string;
  voiceSampleUrl?: string;
  /** ≤12s excerpt used as a zero-shot voice reference (F5-TTS). */
  voiceRefShortUrl?: string;
  voiceSampleText?: string;
  elevenVoiceId?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface Connection {
  platform: Platform | "google";
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  /** Platform account id: channel id, IG user id, page id, person URN, threads user id ... */
  accountId?: string;
  accountName?: string;
  extra?: Record<string, string>;
  status: "ok" | "needs_reauth" | "error";
  lastError?: string;
  updatedAt: string;
}
