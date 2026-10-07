import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV, setKV } from "@/lib/store/kv";
import { saveConnection, DEFAULT_SETTINGS } from "@/lib/db";
import { PUBLISHERS, linkedinVersion, youtubeMeta, isPermanent, hashtagFacets, type PublishInput } from "@/lib/publishers";
import { HttpFailure } from "@/lib/http";
import { PLATFORMS } from "@/lib/types";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let routes: [RegExp, (c: Call) => Response | Promise<Response>][] = [];

function hdrs(h: HeadersInit | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (o[k] = v));
  return o;
}

beforeEach(async () => {
  setKV(new MemoryKV());
  calls = [];
  routes = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const c: Call = { url: String(url), method: init.method ?? "GET", headers: hdrs(init.headers), body: init.body };
    calls.push(c);
    const r = routes.find(([re]) => re.test(c.url));
    if (!r) return new Response(`no route for ${c.url}`, { status: 599 });
    return r[1](c);
  });
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsec";
  process.env.X_CLIENT_ID = "xid";
  const later = new Date(Date.now() + 3600_000).toISOString();
  const farLater = new Date(Date.now() + 50 * 24 * 3600_000).toISOString();
  await saveConnection({ platform: "google", refreshToken: "g-refresh", status: "ok", updatedAt: "" });
  await saveConnection({ platform: "instagram", accessToken: "IGAAtoken", accountId: "1784", expiresAt: farLater, status: "ok", updatedAt: "" });
  await saveConnection({ platform: "facebook", accessToken: "EAApage", accountId: "page1", status: "ok", updatedAt: "" });
  await saveConnection({ platform: "threads", accessToken: "THtoken", accountId: "th1", expiresAt: farLater, status: "ok", updatedAt: "" });
  await saveConnection({ platform: "x", accessToken: "x-access", refreshToken: "x-refresh", expiresAt: later, status: "ok", updatedAt: "" });
  await saveConnection({ platform: "linkedin", accessToken: "li-token", accountId: "urn:li:person:abc", expiresAt: farLater, status: "ok", updatedAt: "" });
  await saveConnection({ platform: "pinterest", accessToken: "pin-token", accountId: "board9", expiresAt: farLater, status: "ok", updatedAt: "" });
  await saveConnection({ platform: "bluesky", accessToken: "app-pass", accountId: "me.bsky.social", status: "ok", updatedAt: "" });
  await saveConnection({ platform: "telegram", accessToken: "123:ABC", accountId: "@mychannel", status: "ok", updatedAt: "" });
});
afterEach(() => vi.unstubAllGlobals());

const json = (o: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" }, ...init });

const input = (): PublishInput => ({
  videoUrl: "https://blob.test/short.mp4",
  thumbnailUrl: "https://blob.test/thumb.jpg",
  readVideo: async () => Buffer.alloc(9 * 1024 * 1024, 1),
  script: {
    hook: "h", spoken: "s", onScreenHook: "o", title: "Big AI news today", description: "d", hashtags: ["AI", "tech"], thumbnailText: "t", cta: "c",
    captions: Object.fromEntries(PLATFORMS.map((p) => [p, `${p} caption`])) as any,
  },
  story: { title: "t", url: "https://src.test/a", source: "Src", summary: "", hash: "x" },
  settings: DEFAULT_SETTINGS,
  privateMode: false,
});

describe("YouTube", () => {
  it("refreshes token, does a resumable upload with synthetic-media disclosure and #Shorts", async () => {
    routes.push([/oauth2\.googleapis\.com\/token/, () => json({ access_token: "ya29", expires_in: 3600 })]);
    routes.push([/upload\/youtube\/v3\/videos\?uploadType=resumable/, () => new Response("", { status: 200, headers: { location: "https://upload.test/session1" } })]);
    routes.push([/upload\.test\/session1/, () => json({ id: "vid123" })]);
    const r = await PUBLISHERS.youtube.step(input(), { state: "pending", attempts: 0 });
    expect(r).toMatchObject({ state: "done", postId: "vid123", url: "https://youtube.com/shorts/vid123" });
    const init = calls.find((c) => c.url.includes("uploadType=resumable"))!;
    const meta = JSON.parse(init.body);
    expect(meta.status.containsSyntheticMedia).toBe(true);
    expect(meta.status.selfDeclaredMadeForKids).toBe(false);
    expect(meta.snippet.title).toMatch(/#Shorts$/);
    expect(init.headers["x-upload-content-length"]).toBe(String(9 * 1024 * 1024));
    expect(calls.find((c) => c.url.includes("session1"))!.method).toBe("PUT");
  });
  it("private test mode forces private", async () => {
    routes.push([/oauth2/, () => json({ access_token: "ya29", expires_in: 3600 })]);
    routes.push([/resumable/, () => new Response("", { headers: { location: "https://upload.test/s" } })]);
    routes.push([/upload\.test\/s/, () => json({ id: "v" })]);
    await PUBLISHERS.youtube.step({ ...input(), privateMode: true }, { state: "pending", attempts: 0 });
    expect(JSON.parse(calls.find((c) => c.url.includes("resumable"))!.body).status.privacyStatus).toBe("private");
  });
  it("description credits source + AI disclosure", () => {
    const m = youtubeMeta(input());
    expect(m.description).toContain("https://src.test/a");
    expect(m.description).toMatch(/AI-generated voice/);
  });
});

describe("Instagram Reels", () => {
  it("creates REELS container, waits, publishes, fetches permalink", async () => {
    let status = "IN_PROGRESS";
    routes.push([/graph\.instagram\.com\/v23\.0\/1784\/media\?|graph\.instagram\.com\/v23\.0\/1784\/media$/, () => json({ id: "cont1" })]);
    routes.push([/cont1\?fields=status_code/, () => json({ status_code: status })]);
    routes.push([/1784\/media_publish/, () => json({ id: "media9" })]);
    routes.push([/media9\?fields=permalink/, () => json({ permalink: "https://instagram.com/reel/abc" })]);
    let r = await PUBLISHERS.instagram.step(input(), { state: "pending", attempts: 0 });
    expect(r.state).toBe("processing");
    const create = new URLSearchParams(String(calls[0].body));
    expect(create.get("media_type")).toBe("REELS");
    expect(create.get("video_url")).toBe("https://blob.test/short.mp4");
    expect(create.get("cover_url")).toBe("https://blob.test/thumb.jpg");
    r = await PUBLISHERS.instagram.step(input(), r);
    expect(r.state).toBe("processing");
    status = "FINISHED";
    r = await PUBLISHERS.instagram.step(input(), r);
    expect(r).toMatchObject({ state: "done", postId: "media9", url: "https://instagram.com/reel/abc" });
  });
  it("ERROR container is reset so the retry rebuilds it", async () => {
    routes.push([/cont1\?fields/, () => json({ status_code: "ERROR", status: "bad codec" })]);
    await expect(PUBLISHERS.instagram.step(input(), { state: "processing", attempts: 0, pending: { container: "cont1" } })).rejects.toMatchObject({ resetPending: true });
  });
});

describe("Facebook Reels", () => {
  it("start -> hosted file_url upload -> finish -> ready", async () => {
    routes.push([/page1\/video_reels/, (c) => (new URLSearchParams(String(c.body)).get("upload_phase") === "start" ? json({ video_id: "fbv1", upload_url: "https://rupload.facebook.com/video-upload/v23.0/fbv1" }) : json({ success: true }))]);
    routes.push([/rupload\.facebook\.com/, () => json({ success: true })]);
    routes.push([/fbv1\?fields=status/, () => json({ status: { video_status: "ready" } })]);
    let r = await PUBLISHERS.facebook.step(input(), { state: "pending", attempts: 0 });
    expect(r.state).toBe("processing");
    const up = calls.find((c) => c.url.includes("rupload"))!;
    expect(up.headers.authorization).toBe("OAuth EAApage");
    expect(up.headers.file_url).toBe("https://blob.test/short.mp4");
    const finish = new URLSearchParams(String(calls.filter((c) => c.url.includes("video_reels"))[1].body));
    expect(finish.get("video_state")).toBe("PUBLISHED");
    r = await PUBLISHERS.facebook.step(input(), r);
    expect(r).toMatchObject({ state: "done", url: "https://www.facebook.com/reel/fbv1" });
  });
});

describe("Threads", () => {
  it("VIDEO container -> FINISHED -> publish", async () => {
    routes.push([/graph\.threads\.net\/v1\.0\/th1\/threads$/, () => json({ id: "tc1" })]);
    routes.push([/tc1\?fields=status/, () => json({ status: "FINISHED" })]);
    routes.push([/th1\/threads_publish/, () => json({ id: "tp1" })]);
    routes.push([/tp1\?fields=permalink/, () => json({ permalink: "https://www.threads.net/@me/post/1" })]);
    let r = await PUBLISHERS.threads.step(input(), { state: "pending", attempts: 0 });
    expect(new URLSearchParams(String(calls[0].body)).get("media_type")).toBe("VIDEO");
    r = await PUBLISHERS.threads.step(input(), r);
    expect(r).toMatchObject({ state: "done", url: "https://www.threads.net/@me/post/1" });
  });
});

describe("X", () => {
  it("chunked upload (<=5MB segments), waits for processing, then posts once", async () => {
    let st = "in_progress";
    routes.push([/media\/upload\/initialize/, () => json({ data: { id: "m1" } })]);
    routes.push([/media\/upload\/m1\/append/, () => new Response(null, { status: 204 })]);
    routes.push([/media\/upload\/m1\/finalize/, () => json({ data: { id: "m1", processing_info: { state: "pending", check_after_secs: 3 } } })]);
    routes.push([/command=STATUS/, () => json({ data: { processing_info: { state: st } } })]);
    routes.push([/2\/tweets/, () => json({ data: { id: "t99" } })]);
    let r = await PUBLISHERS.x.step(input(), { state: "pending", attempts: 0 });
    expect(r.state).toBe("processing");
    const appends = calls.filter((c) => c.url.includes("/append"));
    expect(appends.length).toBe(3); // 9MB / 4MB chunks
    expect(JSON.parse(calls[0].body)).toMatchObject({ media_type: "video/mp4", total_bytes: 9 * 1024 * 1024 });
    expect(calls[0].headers.authorization).toBe("Bearer x-access");
    r = await PUBLISHERS.x.step(input(), r);
    expect(r.state).toBe("processing");
    st = "succeeded";
    r = await PUBLISHERS.x.step(input(), r);
    expect(r).toMatchObject({ state: "done", url: "https://x.com/i/status/t99" });
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/2/tweets"))!.body).media.media_ids).toEqual(["m1"]);
    expect(calls.filter((c) => c.url.includes("initialize")).length).toBe(1);
  });
  it("persists rotated refresh token", async () => {
    await saveConnection({ platform: "x", accessToken: "old", refreshToken: "r1", expiresAt: new Date(0).toISOString(), status: "ok", updatedAt: "" });
    routes.push([/oauth2\/token/, () => json({ access_token: "new-access", refresh_token: "r2", expires_in: 7200 })]);
    const { xAccessToken } = await import("@/lib/connections");
    expect(await xAccessToken()).toBe("new-access");
    const { getConnection } = await import("@/lib/db");
    expect((await getConnection("x"))?.refreshToken).toBe("r2");
  });
});

describe("LinkedIn", () => {
  it("initializeUpload -> PUT parts -> finalize with etags -> AVAILABLE -> post", async () => {
    let status = "PROCESSING";
    routes.push([/rest\/videos\?action=initializeUpload/, () =>
      json({ value: { video: "urn:li:video:V1", uploadToken: "tok", uploadInstructions: [
        { uploadUrl: "https://li-up.test/1", firstByte: 0, lastByte: 4194303 },
        { uploadUrl: "https://li-up.test/2", firstByte: 4194304, lastByte: 9 * 1024 * 1024 - 1 },
      ] } })]);
    routes.push([/li-up\.test\/1/, () => new Response("", { headers: { etag: "e1" } })]);
    routes.push([/li-up\.test\/2/, () => new Response("", { headers: { etag: "e2" } })]);
    routes.push([/finalizeUpload/, () => new Response("", { status: 200 })]);
    routes.push([/rest\/videos\/urn/, () => json({ status })]);
    routes.push([/rest\/posts/, () => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:77" } })]);
    let r = await PUBLISHERS.linkedin.step(input(), { state: "pending", attempts: 0 });
    expect(r.state).toBe("processing");
    expect(JSON.parse(calls.find((c) => c.url.includes("finalizeUpload"))!.body).finalizeUploadRequest.uploadedPartIds).toEqual(["e1", "e2"]);
    expect(calls[0].headers["linkedin-version"]).toMatch(/^\d{6}$/);
    r = await PUBLISHERS.linkedin.step(input(), r);
    expect(r.state).toBe("processing");
    status = "AVAILABLE";
    r = await PUBLISHERS.linkedin.step(input(), r);
    expect(r).toMatchObject({ state: "done", postId: "urn:li:share:77" });
    const post = JSON.parse(calls.find((c) => c.url.includes("rest/posts"))!.body);
    expect(post).toMatchObject({ author: "urn:li:person:abc", lifecycleState: "PUBLISHED", content: { media: { id: "urn:li:video:V1" } } });
  });
  it("version header is two months back", () => {
    expect(linkedinVersion(new Date("2026-10-07T00:00:00Z"))).toBe("202608");
    expect(linkedinVersion(new Date("2026-01-15T00:00:00Z"))).toBe("202511");
  });
});

describe("Pinterest", () => {
  it("registers media, uploads to S3 with the given params, waits, creates a video pin with cover", async () => {
    let status = "processing";
    routes.push([/api\.pinterest\.com\/v5\/media$/, () => json({ media_id: "m77", upload_url: "https://pinterest-media-upload.s3.test/", upload_parameters: { key: "k1", policy: "p1" } })]);
    routes.push([/s3\.test/, () => new Response(null, { status: 204 })]);
    routes.push([/v5\/media\/m77/, () => json({ status })]);
    routes.push([/v5\/pins/, () => json({ id: "pin5" }, { status: 201 })]);
    let r = await PUBLISHERS.pinterest.step(input(), { state: "pending", attempts: 0 });
    expect(r.state).toBe("processing");
    const up = calls.find((c) => c.url.includes("s3.test"))!;
    expect((up.body as FormData).get("key")).toBe("k1");
    expect((up.body as FormData).get("file")).toBeTruthy();
    r = await PUBLISHERS.pinterest.step(input(), r);
    expect(r.state).toBe("processing");
    status = "succeeded";
    r = await PUBLISHERS.pinterest.step(input(), r);
    expect(r).toMatchObject({ state: "done", url: "https://www.pinterest.com/pin/pin5/" });
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v5/pins"))!.body);
    expect(body).toMatchObject({ board_id: "board9", media_source: { source_type: "video_id", media_id: "m77", cover_image_url: "https://blob.test/thumb.jpg" } });
  });
});

describe("Bluesky", () => {
  it("session -> service auth for its PDS -> video service upload -> job poll -> post with video embed + hashtag facets", async () => {
    let state = "JOB_STATE_ENCODING";
    routes.push([/bsky\.social\/xrpc\/com\.atproto\.server\.createSession/, () =>
      json({ accessJwt: "jwt", did: "did:plc:abc", handle: "me.bsky.social", didDoc: { service: [{ id: "#atproto_pds", serviceEndpoint: "https://morel.us-east.host.bsky.network" }] } })]);
    routes.push([/getServiceAuth/, () => json({ token: "svc" })]);
    routes.push([/app\.bsky\.video\.uploadVideo/, () => json({ jobId: "job1", state: "JOB_STATE_CREATED" })]);
    routes.push([/getJobStatus/, () => json({ jobStatus: { state, blob: state === "JOB_STATE_COMPLETED" ? { $type: "blob", ref: { $link: "bafy" }, mimeType: "video/mp4", size: 1 } : undefined } })]);
    routes.push([/createRecord/, () => json({ uri: "at://did:plc:abc/app.bsky.feed.post/3kxyz", cid: "c" })]);
    let r = await PUBLISHERS.bluesky.step(input(), { state: "pending", attempts: 0 });
    expect(r.state).toBe("processing");
    const sa = calls.find((c) => c.url.includes("getServiceAuth"))!;
    expect(sa.url).toContain("morel.us-east.host.bsky.network/xrpc");
    expect(decodeURIComponent(sa.url)).toContain("aud=did:web:morel.us-east.host.bsky.network");
    expect(calls.find((c) => c.url.includes("uploadVideo"))!.headers.authorization).toBe("Bearer svc");
    r = await PUBLISHERS.bluesky.step(input(), r);
    expect(r.state).toBe("processing");
    state = "JOB_STATE_COMPLETED";
    r = await PUBLISHERS.bluesky.step(input(), r);
    expect(r).toMatchObject({ state: "done", url: "https://bsky.app/profile/me.bsky.social/post/3kxyz" });
    const rec = JSON.parse(calls.find((c) => c.url.includes("createRecord"))!.body).record;
    expect(rec.embed).toMatchObject({ $type: "app.bsky.embed.video", aspectRatio: { width: 1080, height: 1920 } });
  });
  it("hashtag facets use UTF-8 byte offsets", () => {
    const f = hashtagFacets("नमस्ते #AI news #tech") as { index: { byteStart: number; byteEnd: number }; features: { tag: string }[] }[];
    const bytes = new TextEncoder().encode("नमस्ते #AI news #tech");
    expect(f.map((x) => x.features[0].tag)).toEqual(["AI", "tech"]);
    expect(new TextDecoder().decode(bytes.slice(f[0].index.byteStart, f[0].index.byteEnd))).toBe("#AI");
  });
});

describe("Telegram", () => {
  it("sendVideo to the channel and builds a public link", async () => {
    routes.push([/api\.telegram\.org\/bot123:ABC\/sendVideo/, () => json({ ok: true, result: { message_id: 42, chat: { username: "mychannel" } } })]);
    const r = await PUBLISHERS.telegram.step(input(), { state: "pending", attempts: 0 });
    expect(r).toMatchObject({ state: "done", url: "https://t.me/mychannel/42" });
    const fd = calls[0].body as FormData;
    expect(fd.get("chat_id")).toBe("@mychannel");
    expect(fd.get("supports_streaming")).toBe("true");
  });
});

describe("error classification", () => {
  it("quota 403 is retryable, permission 403 is permanent", () => {
    expect(isPermanent(new HttpFailure(403, '{"reason":"quotaExceeded"}', "u"))).toBe(false);
    expect(isPermanent(new HttpFailure(403, '{"error":"insufficient permissions"}', "u"))).toBe(true);
    expect(isPermanent(new HttpFailure(500, "boom", "u"))).toBe(false);
  });
});
