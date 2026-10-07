import { falAvailable, falResult, falStatus, falSubmit } from "./fal";
import type { AvatarRequest } from "../types";

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

export const AVATAR_REGISTRY: Record<string, AvatarProvider> = {
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
