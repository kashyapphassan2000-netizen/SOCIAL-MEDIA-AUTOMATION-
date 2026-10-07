import { falAvailable, falResult, falStatus, falSubmit } from "./fal";
import type { AvatarRequest } from "../types";
import { enqueueTask, freeWorkerEnabled, getTask } from "../freeworker";

/**
 * Talking-head generators. All are async: submit -> poll on later ticks -> fetch result.
 * "still" is the guaranteed last resort: the editor animates the photo itself (no lip-sync).
 */
export interface AvatarInput {
  imageUrl: string;
  audioUrl: string;
  clipUrl?: string;
  audioSeconds: number;
}

export type AvatarPoll = { state: "pending" } | { state: "done"; videoUrl: string } | { state: "failed"; error: string };

export interface AvatarProvider {
  name: string;
  /** Max audio seconds the model accepts. */
  maxSeconds: number;
  /** Give up and fall back after this many minutes (default 25). */
  timeoutMin?: number;
  available(inp: AvatarInput): boolean;
  submit(inp: AvatarInput): Promise<AvatarRequest>;
  poll(req: AvatarRequest): Promise<AvatarPoll>;
}

function falProvider(name: string, model: string, maxSeconds: number, build: (i: AvatarInput) => Record<string, unknown>, needsClip = false): AvatarProvider {
  return {
    name,
    maxSeconds,
    available: (i) => falAvailable() && (!needsClip || !!i.clipUrl),
    async submit(inp) {
      const r = await falSubmit(model, build(inp));
      return { provider: name, requestId: r.request_id, statusUrl: r.status_url, responseUrl: r.response_url, submittedAt: new Date().toISOString() };
    },
    async poll(req) {
      const s = await falStatus(req.statusUrl!);
      if (s.status === "COMPLETED") {
        try {
          const out = await falResult<{ video?: { url: string } }>(req.responseUrl!);
          return out.video?.url ? { state: "done", videoUrl: out.video.url } : { state: "failed", error: "no video in result" };
        } catch (e) {
          return { state: "failed", error: (e as Error).message };
        }
      }
      if (s.status === "FAILED" || s.error) return { state: "failed", error: s.error ?? "failed" };
      return { state: "pending" };
    },
  };
}

function freeWorkerProvider(name: string, kind: "lipsync" | "avatar", maxSeconds: number, input: (i: AvatarInput) => Record<string, string> | null): AvatarProvider {
  return {
    name,
    maxSeconds,
    timeoutMin: Number(process.env.FREE_AVATAR_TIMEOUT_MIN || 150),
    available: (i) => freeWorkerEnabled() && input(i) !== null,
    async submit(i) {
      const t = await enqueueTask(kind, input(i)!);
      return { provider: name, requestId: t.id, submittedAt: new Date().toISOString() };
    },
    async poll(req) {
      const t = await getTask(req.requestId);
      if (!t) return { state: "failed", error: "task expired" };
      if (t.status === "done" && t.outputUrl) return { state: "done", videoUrl: t.outputUrl };
      if (t.status === "failed") return { state: "failed", error: t.error ?? "worker failed" };
      return { state: "pending" };
    },
  };
}

export const AVATAR_REGISTRY: Record<string, AvatarProvider> = {
  // FREE + MOST NATURAL: lip-sync onto one of YOUR real recorded clips (LatentSync / MuseTalk plugin on your worker).
  // Real body, real hands, real background — only the mouth is AI.
  "free-lipsync": freeWorkerProvider("free-lipsync", "lipsync", 120, (i) => (i.clipUrl ? { videoUrl: i.clipUrl, audioUrl: i.audioUrl } : null)),
  // FREE: photo -> talking video on your worker (EchoMimicV3-Flash with gestures on a GPU, SadTalker on CPU).
  "free-avatar": freeWorkerProvider("free-avatar", "avatar", 90, (i) => ({ imageUrl: i.imageUrl, audioUrl: i.audioUrl })),
  // ByteDance OmniHuman 1.5 — best expressiveness; 720p accepts up to 60s audio.
  "fal-omnihuman": falProvider("fal-omnihuman", process.env.FAL_OMNIHUMAN_MODEL || "fal-ai/bytedance/omnihuman/v1.5", 60, (i) => ({
    image_url: i.imageUrl,
    audio_url: i.audioUrl,
    resolution: "720p",
    prompt: "A confident creator talking directly to camera, natural head movement, subtle hand gestures, professional studio lighting",
  })),
  // VEED Fabric 1.0 — strong lip-sync, cheaper at 480p.
  "fal-fabric": falProvider("fal-fabric", process.env.FAL_FABRIC_MODEL || "veed/fabric-1.0", 60, (i) => ({ image_url: i.imageUrl, audio_url: i.audioUrl, resolution: "720p" })),
  // Re-lip-sync the creator's own recorded clip (looped) to the new audio — most realistic body motion.
  "fal-lipsync-clip": falProvider(
    "fal-lipsync-clip",
    process.env.FAL_LIPSYNC_MODEL || "fal-ai/sync-lipsync/v2",
    120,
    (i) => ({ video_url: i.clipUrl, audio_url: i.audioUrl, sync_mode: "bounce" }),
    true,
  ),
  still: {
    name: "still",
    maxSeconds: 600,
    available: () => true,
    async submit() {
      return { provider: "still", requestId: "local", submittedAt: new Date().toISOString() };
    },
    async poll() {
      return { state: "done", videoUrl: "" };
    },
  },
};
// backwards-compatible alias
AVATAR_REGISTRY["free-sadtalker"] = AVATAR_REGISTRY["free-avatar"];
