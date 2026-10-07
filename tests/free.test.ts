import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV, setKV, getKV } from "@/lib/store/kv";
import { claimTask, completeTask, enqueueTask, getTask } from "@/lib/freeworker";
import { OpenAICompatLLM } from "@/lib/ai/llm";
import { VOICE_REGISTRY } from "@/lib/ai/voice";
import { AVATAR_REGISTRY } from "@/lib/ai/avatar";
import { setDeps, createJob, tick } from "@/lib/engine";
import { getJob, getSettings, saveSettings } from "@/lib/db";
import { fastForward, mockLLM, mockPublishers, saveSchedule, schedule, setup, work } from "./helpers";
import { runFfmpeg } from "@/lib/media/ffmpeg";
import path from "node:path";

describe("free worker queue", () => {
  beforeEach(() => {
    setKV(new MemoryKV());
    delete process.env.GH_DISPATCH_TOKEN;
  });

  it("claims oldest task of the requested kind once, completes it", async () => {
    const a = await enqueueTask("tts", { text: "hi" });
    const b = await enqueueTask("avatar", { imageUrl: "x" });
    const c1 = await claimTask(["avatar"], "w1");
    expect(c1?.id).toBe(b.id);
    expect(await claimTask(["avatar"], "w2")).toBeNull(); // already claimed, lease valid
    const c2 = await claimTask(["tts", "avatar"], "w2");
    expect(c2?.id).toBe(a.id);
    await completeTask(a.id, { outputUrl: "https://blob/x.mp3" });
    expect((await getTask(a.id))?.status).toBe("done");
    expect(await claimTask(["tts"], "w3")).toBeNull();
  });

  it("re-queues a task whose worker died (lease expired), fails it after 2 attempts", async () => {
    const t = await enqueueTask("avatar", { imageUrl: "x" });
    await claimTask(["avatar"], "w1");
    const kv = getKV();
    const stale = (await getTask(t.id))!;
    await kv.set(`ftask:${t.id}`, { ...stale, claimedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    await kv.del(`ftask:lock:${t.id}`);
    const again = await claimTask(["avatar"], "w2");
    expect(again?.attempts).toBe(2);
    await kv.set(`ftask:${t.id}`, { ...again!, claimedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    await kv.del(`ftask:lock:${t.id}`);
    expect(await claimTask(["avatar"], "w3")).toBeNull();
    expect((await getTask(t.id))?.status).toBe("failed");
  });

  it("dispatches the GitHub Actions worker once per kind (debounced)", async () => {
    process.env.GH_DISPATCH_TOKEN = "ghp_x";
    process.env.GITHUB_REPO = "me/repo";
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(null, { status: 204 });
    });
    await enqueueTask("tts", { text: "a" });
    await enqueueTask("tts", { text: "b" });
    await enqueueTask("avatar", { imageUrl: "c" });
    vi.unstubAllGlobals();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.github.com/repos/me/repo/actions/workflows/free-worker.yml/dispatches");
    expect(JSON.parse(calls[0].body)).toEqual({ ref: "main", inputs: { kinds: "tts" } });
    expect(JSON.parse(calls[1].body).inputs.kinds).toBe("avatar");
  });
});

describe("free LLM providers (OpenAI-compatible)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("picks the best available model from /models and calls chat/completions", async () => {
    process.env.TEST_KEY = "k";
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      seen.push(url);
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "nvidia/embed-qa" }, { id: "meta/llama-3.1-8b-instruct" }, { id: "openai/gpt-oss-120b" }] });
      const body = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: `{"model":"${body.model}"}` } }] });
    });
    const llm = new OpenAICompatLLM("test", "https://x.test/v1", "TEST_KEY", "TEST_MODEL", [/gpt-oss-120b/, /70b/]);
    expect(await llm.complete("s", "u")).toBe('{"model":"openai/gpt-oss-120b"}');
    await llm.complete("s", "u");
    expect(seen.filter((u) => u.endsWith("/models"))).toHaveLength(1); // cached
  });
  it("falls back to any chat model when no preferred one exists, skipping embeddings", async () => {
    process.env.TEST_KEY = "k";
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/models") ? Response.json({ data: [{ id: "x/embed-1" }, { id: "x/chat-small" }] }) : Response.json({ choices: [{ message: { content: "{}" } }] }),
    );
    const llm = new OpenAICompatLLM("t2", "https://y.test/v1", "TEST_KEY", "TEST_MODEL2", [/nope/]);
    expect(await llm.model()).toBe("x/chat-small");
  });
});

describe("pipeline on the free stack (async voice + avatar via worker queue)", () => {
  it("queues voice + avatar tasks, waits for the worker, then edits, publishes and deletes worker outputs", async () => {
    await setup();
    process.env.WORKER_SECRET = "ws";
    delete process.env.GH_DISPATCH_TOKEN;
    const s = await getSettings();
    await saveSettings({ ...s, generateLooks: false, voiceProviders: ["free-voice"], avatarProviders: ["free-avatar", "still"] });
    const { pubs } = mockPublishers({});
    setDeps({
      llms: () => [mockLLM()],
      voices: () => [VOICE_REGISTRY["free-voice"]],
      avatars: () => [AVATAR_REGISTRY["free-avatar"], AVATAR_REGISTRY.still],
      trends: async () => ({ stories: [{ title: "Story", url: "https://e.x/a", source: "E", summary: "", hash: "z1" }], errors: [] }),
      publishers: pubs,
      generateLook: async () => Buffer.alloc(0),
    });
    const sch = schedule({ platforms: ["youtube", "telegram"], language: "hi" });
    await saveSchedule(sch);
    const job = await createJob(sch, "manual", "t");

    // Pretend to be the Python worker: claim, render with ffmpeg, upload to storage, complete.
    const { getStorage } = await import("@/lib/storage");
    const fakeWorker = async () => {
      const t = await claimTask(["tts", "avatar"], "test-worker");
      if (!t) return null;
      const out = path.join(work, `${t.id}.${t.kind === "tts" ? "mp3" : "mp4"}`);
      if (t.kind === "tts") {
        expect(t.input.language).toBe("hi");
        expect(String(t.input.refAudioUrl)).toMatch(/^file:\/\//);
        await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=f=220:d=12", "-c:a", "libmp3lame", out]);
      } else {
        await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=512x704:d=3:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
      }
      const url = await getStorage().put(path.basename(out), fs.readFileSync(out), "application/octet-stream");
      await completeTask(t.id, { outputUrl: url });
      return t.kind;
    };

    const kinds: string[] = [];
    for (let i = 0; i < 30; i++) {
      await tick({ budgetSec: 280, enqueue: false });
      const k = await fakeWorker();
      if (k) kinds.push(k);
      await fastForward();
      if ((await getJob(job.id))?.stage === "done") break;
    }
    const done = await getJob(job.id);
    expect(kinds).toEqual(["tts", "avatar"]);
    expect(done?.status).toBe("done");
    expect(done?.data.voiceProvider).toBe("free-voice");
    expect(done?.data.avatarProvider).toBe("free-avatar");
    expect(done?.data.audioSeconds).toBeGreaterThan(11);
    // worker outputs are ours (Blob) -> deleted after publishing
    for (const u of [done!.data.audioUrl!, done!.data.avatarUrl!]) expect(fs.existsSync(u.slice(7))).toBe(false);
    delete process.env.WORKER_SECRET;
  });

  it("clip mode: lip-syncs onto rotating real clips and uses worker word timings for captions", async () => {
    const { fx } = await setup();
    process.env.WORKER_SECRET = "ws";
    const { saveAssets, getAssets } = await import("@/lib/db");
    await saveAssets({ ...(await getAssets()), clips: [{ url: fx.voice.replace(".mp3", "-a.mp4"), name: "studio blazer", addedAt: "" }, { url: "file:///clip-b.mp4", name: "desk tee", addedAt: "" }] });
    const s = await getSettings();
    await saveSettings({ ...s, avatarMode: "clip", generateLooks: false });
    const { pubs } = mockPublishers({});
    setDeps({
      llms: () => [mockLLM()],
      voices: () => [VOICE_REGISTRY["free-voice"]],
      avatars: () => [AVATAR_REGISTRY["free-lipsync"], AVATAR_REGISTRY["free-avatar"], AVATAR_REGISTRY.still],
      trends: async () => ({ stories: [{ title: "Story", url: "", source: "E", summary: "", hash: "z3" }], errors: [] }),
      publishers: pubs,
      generateLook: async () => Buffer.alloc(0),
    });
    const sch = schedule({ platforms: ["youtube"] });
    await saveSchedule(sch);
    const job = await createJob(sch, "manual", "t");
    const { getStorage } = await import("@/lib/storage");
    let lipsyncInput: Record<string, unknown> | null = null;
    const timed = [{ word: "OpenAI", start: 0.1, end: 0.5 }, { word: "just", start: 0.5, end: 0.7 }];
    for (let i = 0; i < 30; i++) {
      await tick({ budgetSec: 280, enqueue: false });
      const t = await claimTask(["tts", "lipsync", "avatar"], "w");
      if (t?.kind === "tts") {
        const out = path.join(work, `${t.id}.mp3`);
        await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=f=220:d=9", "-c:a", "libmp3lame", out]);
        await completeTask(t.id, { outputUrl: await getStorage().put("v.mp3", fs.readFileSync(out), "audio/mpeg"), meta: { plugin: "voxcpm2", words: timed } });
      } else if (t?.kind === "lipsync") {
        lipsyncInput = t.input;
        const out = path.join(work, `${t.id}.mp4`);
        await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:d=3:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
        await completeTask(t.id, { outputUrl: await getStorage().put("l.mp4", fs.readFileSync(out), "video/mp4") });
      }
      await fastForward();
      if ((await getJob(job.id))?.stage === "done") break;
    }
    const done = await getJob(job.id);
    expect(done?.status).toBe("done");
    expect(String(lipsyncInput?.videoUrl)).toMatch(/clip-b\.mp4|-a\.mp4/);
    expect(done?.data.avatarProvider).toBe("free-lipsync");
    expect(done?.data.voiceProvider).toBe("free-voice/voxcpm2");
    expect(done?.data.words).toEqual(timed);
    expect(done?.data.lookName).toMatch(/^clip: /);
    delete process.env.WORKER_SECRET;
  });

  it("falls back to the next provider when the worker reports failure", async () => {
    await setup();
    process.env.WORKER_SECRET = "ws";
    const s = await getSettings();
    await saveSettings({ ...s, generateLooks: false });
    const { pubs } = mockPublishers({});
    setDeps({
      llms: () => [mockLLM()],
      voices: () => [VOICE_REGISTRY["free-voice"]],
      avatars: () => [AVATAR_REGISTRY["free-avatar"], AVATAR_REGISTRY.still],
      trends: async () => ({ stories: [{ title: "Story", url: "", source: "E", summary: "", hash: "z2" }], errors: [] }),
      publishers: pubs,
      generateLook: async () => Buffer.alloc(0),
    });
    const sch = schedule({ platforms: ["youtube"] });
    await saveSchedule(sch);
    const job = await createJob(sch, "manual", "t");
    const { getStorage } = await import("@/lib/storage");
    for (let i = 0; i < 30; i++) {
      await tick({ budgetSec: 280, enqueue: false });
      const t = await claimTask(["tts", "avatar"], "w");
      if (t?.kind === "tts") {
        const out = path.join(work, `${t.id}.mp3`);
        await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=f=220:d=8", "-c:a", "libmp3lame", out]);
        await completeTask(t.id, { outputUrl: await getStorage().put("v.mp3", fs.readFileSync(out), "audio/mpeg") });
      } else if (t?.kind === "avatar") {
        await completeTask(t.id, { error: "RuntimeError: No face is detected" });
      }
      await fastForward();
      if ((await getJob(job.id))?.stage === "done") break;
    }
    const done = await getJob(job.id);
    expect(done?.status).toBe("done");
    expect(done?.data.avatarProvider).toContain("still");
    expect(done?.logs.some((l) => /No face is detected/.test(l.msg))).toBe(true);
    delete process.env.WORKER_SECRET;
  });
});
