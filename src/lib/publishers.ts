import { googleAccessToken, linkedinAccessToken, metaToken, xAccessToken } from "./connections";
import { form, http, httpJson, HttpFailure } from "./http";
import type { BrandSettings, Platform, PublishResult, Script, Story } from "./types";

export interface PublishInput {
  videoUrl: string;
  thumbnailUrl?: string;
  readVideo(): Promise<Buffer>;
  script: Script;
  story?: Story;
  settings: BrandSettings;
  privateMode: boolean;
}

/**
 * Each publisher is a resumable step: call it with the previous result; it either finishes,
 * or returns state "processing" + pending ids, and the engine calls again later.
 */
export interface Publisher {
  platform: Platform;
  step(inp: PublishInput, prev: PublishResult): Promise<PublishResult>;
}

const later = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();
const processing = (prev: PublishResult, pending: Record<string, string>, waitSec = 20): PublishResult => ({
  ...prev,
  state: "processing",
  pending: { ...(prev.pending ?? {}), ...pending },
  nextAttemptAt: later(waitSec),
});
const done = (prev: PublishResult, postId: string, url: string): PublishResult => ({ ...prev, state: "done", postId, url, pending: undefined, error: undefined, nextAttemptAt: undefined });

function tags(s: Script, n: number) {
  return s.hashtags.slice(0, n).map((h) => `#${h}`).join(" ");
}

export function youtubeMeta(inp: PublishInput) {
  const { script, story, settings } = inp;
  let title = script.title.replace(/[<>]/g, "");
  if (!/#shorts/i.test(title)) title = `${title.slice(0, 90)} #Shorts`;
  const desc = [
    script.captions.youtube,
    story?.url ? `\nSource: ${story.source} — ${story.url}` : "",
    `\nFollow ${settings.handle} for more.`,
    "\nThis video uses an AI-generated voice and avatar of the creator.",
    !/#shorts/i.test(script.captions.youtube) ? "\n#Shorts" : "",
  ].join("");
  return { title: title.slice(0, 100), description: desc.replace(/[<>]/g, "").slice(0, 4900) };
}

// ---------------- YouTube Shorts (resumable upload) ----------------
export const youtube: Publisher = {
  platform: "youtube",
  async step(inp, prev) {
    const token = await googleAccessToken();
    const video = await inp.readVideo();
    const { title, description } = youtubeMeta(inp);
    const meta = {
      snippet: { title, description, tags: inp.script.hashtags.slice(0, 15), categoryId: inp.settings.youtubeCategoryId || "28" },
      status: {
        privacyStatus: inp.privateMode ? "private" : inp.settings.youtubePrivacy,
        selfDeclaredMadeForKids: false,
        // Required disclosure for realistic altered/synthetic media (cloned voice + AI avatar).
        containsSyntheticMedia: true,
        embeddable: true,
      },
    };
    const init = await http("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(video.length),
      },
      body: JSON.stringify(meta),
      retries: 1,
    });
    const location = init.headers.get("location");
    if (!location) throw new Error("YouTube did not return an upload URL");
    const up = await http(location, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "video/mp4", "Content-Length": String(video.length) },
      body: new Uint8Array(video),
      timeoutMs: 240_000,
      retries: 1,
    });
    const v = (await up.json()) as { id: string };
    return done(prev, v.id, `https://youtube.com/shorts/${v.id}`);
  },
};

// ---------------- Instagram Reels (container -> poll -> publish) ----------------
export const instagram: Publisher = {
  platform: "instagram",
  async step(inp, prev) {
    const { token, id, host } = await metaToken("instagram");
    const container = prev.pending?.container;
    if (!container) {
      const caption = inp.script.captions.instagram.slice(0, 2150);
      const r = await httpJson<{ id: string }>(`${host}/${id}/media`, {
        method: "POST",
        body: form({ media_type: "REELS", video_url: inp.videoUrl, caption, share_to_feed: true, cover_url: inp.thumbnailUrl, access_token: token }),
      });
      return processing(prev, { container: r.id }, 30);
    }
    const st = await httpJson<{ status_code: string; status?: string }>(`${host}/${container}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    if (st.status_code === "IN_PROGRESS") return processing(prev, {}, 30);
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      // Container is dead: drop it so the retry builds a fresh one.
      throw Object.assign(new Error(`Instagram processing ${st.status_code}: ${st.status ?? ""}`), { resetPending: true });
    }
    if (st.status_code === "PUBLISHED") return done(prev, prev.pending?.media ?? container, prev.url ?? "https://instagram.com");
    const pub = await httpJson<{ id: string }>(`${host}/${id}/media_publish`, { method: "POST", body: form({ creation_id: container, access_token: token }) });
    const link = await httpJson<{ permalink?: string }>(`${host}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(token)}`).catch(() => ({}) as { permalink?: string });
    return done(prev, pub.id, link.permalink ?? `https://instagram.com`);
  },
};

// ---------------- Facebook Page Reels (start -> hosted upload -> finish -> poll) ----------------
export const facebook: Publisher = {
  platform: "facebook",
  async step(inp, prev) {
    const { token, id, host } = await metaToken("facebook");
    const videoId = prev.pending?.videoId;
    if (!videoId) {
      const start = await httpJson<{ video_id: string; upload_url: string }>(`${host}/${id}/video_reels`, {
        method: "POST",
        body: form({ upload_phase: "start", access_token: token }),
      });
      await http(start.upload_url || `https://rupload.facebook.com/video-upload/${host.split("/").pop()}/${start.video_id}`, {
        method: "POST",
        headers: { Authorization: `OAuth ${token}`, file_url: inp.videoUrl },
        timeoutMs: 180_000,
      });
      await httpJson(`${host}/${id}/video_reels`, {
        method: "POST",
        body: form({ upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: inp.script.captions.facebook.slice(0, 2000), access_token: token }),
      });
      return processing(prev, { videoId: start.video_id }, 30);
    }
    const st = await httpJson<{ status?: { video_status?: string; processing_phase?: { status?: string; error?: { message?: string } } } }>(
      `${host}/${videoId}?fields=status&access_token=${encodeURIComponent(token)}`,
    );
    const vs = st.status?.video_status;
    if (vs === "error" || st.status?.processing_phase?.status === "error") {
      throw Object.assign(new Error(`Facebook processing error: ${st.status?.processing_phase?.error?.message ?? ""}`), { resetPending: true });
    }
    if (vs === "ready" || vs === "published") return done(prev, videoId, `https://www.facebook.com/reel/${videoId}`);
    return processing(prev, {}, 30);
  },
};

// ---------------- Threads (container -> poll -> publish) ----------------
export const threads: Publisher = {
  platform: "threads",
  async step(inp, prev) {
    const { token, id, host } = await metaToken("threads");
    const container = prev.pending?.container;
    if (!container) {
      const r = await httpJson<{ id: string }>(`${host}/${id}/threads`, {
        method: "POST",
        body: form({ media_type: "VIDEO", video_url: inp.videoUrl, text: inp.script.captions.threads.slice(0, 495), access_token: token }),
      });
      return processing(prev, { container: r.id }, 30);
    }
    const st = await httpJson<{ status: string; error_message?: string }>(`${host}/${container}?fields=status,error_message&access_token=${encodeURIComponent(token)}`);
    if (st.status === "IN_PROGRESS") return processing(prev, {}, 30);
    if (st.status === "ERROR" || st.status === "EXPIRED") {
      throw Object.assign(new Error(`Threads processing ${st.status}: ${st.error_message ?? ""}`), { resetPending: true });
    }
    if (st.status === "PUBLISHED") return done(prev, container, prev.url ?? "https://www.threads.net");
    const pub = await httpJson<{ id: string }>(`${host}/${id}/threads_publish`, { method: "POST", body: form({ creation_id: container, access_token: token }) });
    const link = await httpJson<{ permalink?: string }>(`${host}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(token)}`).catch(() => ({}) as { permalink?: string });
    return done(prev, pub.id, link.permalink ?? "https://www.threads.net");
  },
};

// ---------------- X (chunked media upload -> processing -> post) ----------------
const X = "https://api.x.com/2";
export const x: Publisher = {
  platform: "x",
  async step(inp, prev) {
    const token = await xAccessToken();
    const H = { Authorization: `Bearer ${token}` };
    let mediaId = prev.pending?.mediaId;
    if (!mediaId) {
      const video = await inp.readVideo();
      const init = await httpJson<{ data: { id: string } }>(`${X}/media/upload/initialize`, {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ media_type: "video/mp4", total_bytes: video.length, media_category: "tweet_video" }),
      });
      mediaId = init.data.id;
      const CHUNK = 4 * 1024 * 1024;
      for (let i = 0, seg = 0; i < video.length; i += CHUNK, seg++) {
        const fd = new FormData();
        fd.set("segment_index", String(seg));
        fd.set("media", new Blob([new Uint8Array(video.subarray(i, i + CHUNK))], { type: "application/octet-stream" }), "chunk");
        await http(`${X}/media/upload/${mediaId}/append`, { method: "POST", headers: H, body: fd, timeoutMs: 120_000 });
      }
      const fin = await httpJson<{ data: { processing_info?: { state: string; check_after_secs?: number } } }>(`${X}/media/upload/${mediaId}/finalize`, { method: "POST", headers: H });
      const pi = fin.data.processing_info;
      if (pi && pi.state !== "succeeded") return processing(prev, { mediaId }, Math.max(5, pi.check_after_secs ?? 10));
    } else if (!prev.pending?.tweeted) {
      const st = await httpJson<{ data: { processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } } }>(
        `${X}/media/upload?command=STATUS&media_id=${mediaId}`,
        { headers: H },
      );
      const pi = st.data.processing_info;
      if (pi?.state === "failed") throw Object.assign(new Error(`X media processing failed: ${pi.error?.message ?? ""}`), { resetPending: true });
      if (pi && pi.state !== "succeeded") return processing(prev, { mediaId }, Math.max(5, pi.check_after_secs ?? 10));
    }
    const text = inp.script.captions.x.slice(0, 275);
    const tw = await httpJson<{ data: { id: string } }>(`${X}/tweets`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ text, media: { media_ids: [mediaId] } }),
      retries: 0, // never double-post
    });
    return done(prev, tw.data.id, `https://x.com/i/status/${tw.data.id}`);
  },
};

// ---------------- LinkedIn (Videos API multipart -> wait AVAILABLE -> Posts API) ----------------
export function linkedinVersion(d = new Date()): string {
  if (process.env.LINKEDIN_VERSION) return process.env.LINKEDIN_VERSION;
  // LinkedIn supports each monthly version for ~1 year; two months back is always live.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const linkedin: Publisher = {
  platform: "linkedin",
  async step(inp, prev) {
    const { token, author } = await linkedinAccessToken();
    const H = { Authorization: `Bearer ${token}`, "LinkedIn-Version": linkedinVersion(), "X-Restli-Protocol-Version": "2.0.0" };
    let videoUrn = prev.pending?.videoUrn;
    if (!videoUrn) {
      const video = await inp.readVideo();
      const init = await httpJson<{ value: { video: string; uploadToken: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] } }>(
        "https://api.linkedin.com/rest/videos?action=initializeUpload",
        {
          method: "POST",
          headers: { ...H, "Content-Type": "application/json" },
          body: JSON.stringify({ initializeUploadRequest: { owner: author, fileSizeBytes: video.length, uploadCaptions: false, uploadThumbnail: false } }),
        },
      );
      const etags: string[] = [];
      for (const ins of init.value.uploadInstructions) {
        const res = await http(ins.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(video.subarray(ins.firstByte, ins.lastByte + 1)),
          timeoutMs: 180_000,
        });
        etags.push(res.headers.get("etag") ?? "");
      }
      await http("https://api.linkedin.com/rest/videos?action=finalizeUpload", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ finalizeUploadRequest: { video: init.value.video, uploadToken: init.value.uploadToken, uploadedPartIds: etags } }),
      });
      videoUrn = init.value.video;
      return processing(prev, { videoUrn }, 20);
    }
    const st = await httpJson<{ status: string }>(`https://api.linkedin.com/rest/videos/${encodeURIComponent(videoUrn)}`, { headers: H });
    if (st.status === "PROCESSING_FAILED") throw Object.assign(new Error("LinkedIn video processing failed"), { resetPending: true });
    if (st.status !== "AVAILABLE") return processing(prev, {}, 20);
    const res = await http("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({
        author,
        commentary: `${inp.script.captions.linkedin}`.slice(0, 2900),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { title: inp.script.title.slice(0, 200), id: videoUrn } },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
      retries: 0,
    });
    const postUrn = res.headers.get("x-restli-id") ?? "";
    return done(prev, postUrn, postUrn ? `https://www.linkedin.com/feed/update/${postUrn}` : "https://www.linkedin.com");
  },
};

export const PUBLISHERS: Record<Platform, Publisher> = { youtube, instagram, facebook, threads, x, linkedin };

/** Errors that will never succeed on retry (bad permissions / policy) — fail fast instead of burning attempts. */
export function isPermanent(e: unknown): boolean {
  if (e instanceof HttpFailure) {
    if ([400, 401, 403, 404, 422].includes(e.status)) {
      // Rate-limit style 403s from Google / Meta are transient.
      return !/quota|rate|limit|temporar|try again|uploadLimitExceeded/i.test(e.body);
    }
  }
  return false;
}

export { tags as hashtagLine };
