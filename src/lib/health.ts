import { getKV } from "./store/kv";
import { getAssets, getSettings, listConnections } from "./db";
import { getStorage } from "./storage";
import fs from "node:fs";
import path from "node:path";
import { ffmpegPath, fontsDir, rmrf, runFfmpeg, tmpDir } from "./media/ffmpeg";
import { buildThumbnailAss } from "./media/captions";
import { googleAccessToken, linkedinAccessToken, metaToken, pinterestToken, xAccessToken } from "./connections";
import { queueStats } from "./freeworker";
import { httpJson } from "./http";
import { flushSheet } from "./sheets";
import { LLM_REGISTRY } from "./ai/llm";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

async function check(name: string, fn: () => Promise<string>, fix?: string): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message.slice(0, 300), fix };
  }
}

/** Live end-to-end checks of every dependency, with the exact fix when something is wrong. */
export async function runHealth(): Promise<Check[]> {
  const s = await getSettings();
  const a = await getAssets();
  const conns = await listConnections();
  const want = (p: string) => !!conns[p] || false;
  const checks: Promise<Check>[] = [
    check("Database (Upstash Redis)", async () => {
      const kv = getKV();
      await kv.set("health:ping", Date.now(), { ttlSec: 60 });
      return "read/write OK";
    }, "Vercel → Storage/Marketplace → add Upstash Redis to this project"),
    check("File storage (Vercel Blob)", async () => {
      const st = getStorage();
      if (!st.publicUrls && process.env.VERCEL) throw new Error("BLOB_READ_WRITE_TOKEN missing");
      const url = await st.put("health/ping.txt", Buffer.from("ok"), "text/plain");
      await st.del([url]);
      return st.publicUrls ? "public upload + delete OK" : "local disk (dev only — platforms cannot fetch these URLs)";
    }, "Vercel → Storage → create a Blob store and connect it to the project"),
    check("Video engine (ffmpeg + captions)", async () => {
      // Real render of one captioned frame with the bundled font — proves binary, libass and font are deployed.
      const dir = tmpDir();
      try {
        const ass = path.join(dir, "t.ass");
        fs.writeFileSync(ass, buildThumbnailAss("OK", "@test", "#000000", "#FFD60A", 270, 480));
        const t0 = Date.now();
        await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x222222:s=270x480:d=1", "-vf", `subtitles=${ass}:fontsdir=${fontsDir()}`, "-frames:v", "1", path.join(dir, "o.png")], 30_000);
        return `${ffmpegPath()} — captioned frame rendered in ${Date.now() - t0}ms`;
      } finally {
        rmrf(dir);
      }
    }),
    check("Script AI (LLM)", async () => {
      const on = s.llmProviders.filter((n) => LLM_REGISTRY[n]?.available());
      if (!on.length) throw new Error("no LLM key set");
      return `available: ${on.join(" → ")}`;
    }, "Set a FREE key: GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY or NVIDIA_API_KEY"),
    check("Voice clone", async () => {
      if (!a.voiceSampleUrl) throw new Error("no voice clip uploaded");
      const parts: string[] = [];
      if (process.env.ELEVENLABS_API_KEY) {
        const u = await httpJson<{ subscription?: { tier?: string; character_count?: number; character_limit?: number } }>("https://api.elevenlabs.io/v1/user", {
          headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        });
        parts.push(`ElevenLabs ${u.subscription?.tier ?? ""} ${u.subscription?.character_count ?? "?"}/${u.subscription?.character_limit ?? "?"} chars, voice ${a.elevenVoiceId || process.env.ELEVENLABS_VOICE_ID ? "cloned" : "not yet cloned"}`);
      }
      if (process.env.WORKER_SECRET) parts.unshift("FREE Chatterbox clone on your worker");
      if (process.env.FAL_KEY) parts.push("fal F5 zero-shot fallback ready");
      if (!parts.length) throw new Error("no voice provider: set WORKER_SECRET (free worker) or ELEVENLABS_API_KEY / FAL_KEY");
      return parts.join("; ");
    }, "Studio → upload a 60-120s voice clip; set WORKER_SECRET (free worker) or ELEVENLABS_API_KEY"),
    check("Talking avatar", async () => {
      if (!a.photoUrl) throw new Error("no photo uploaded");
      if (!process.env.FAL_KEY && !process.env.WORKER_SECRET) throw new Error("no lip-sync provider — set WORKER_SECRET (free SadTalker worker) or FAL_KEY; only the still-photo fallback will work");
      const looks = process.env.FAL_KEY ? `looks generated: ${s.looks.filter((l) => l.imageUrl).length}/${s.looks.length}` : "outfit looks need FAL_KEY (free mode uses your original photo)";
      return `providers: ${s.avatarProviders.join(" → ")}; ${looks}`;
    }, "Studio → upload photo; set WORKER_SECRET (free) and/or FAL_KEY"),
    check("Google Sheet log", async () => {
      const id = s.sheetId || process.env.GOOGLE_SHEET_ID;
      if (!id) throw new Error("no sheet id");
      const n = await flushSheet();
      return `connected (flushed ${n} buffered rows)`;
    }, "Settings → paste the Sheet ID; connect Google (or share the sheet with the service account)"),
    check("Cron secret", async () => {
      if (!process.env.CRON_SECRET) throw new Error("CRON_SECRET missing — automation cannot self-trigger");
      return "set";
    }, "Set CRON_SECRET in Vercel env and the same value as a GitHub Actions secret"),
  ];
  if (want("google") || process.env.GOOGLE_REFRESH_TOKEN)
    checks.push(check("YouTube", async () => {
      const t = await googleAccessToken();
      const r = await httpJson<{ items?: { snippet: { title: string }; status?: { longUploadsStatus?: string } }[] }>("https://www.googleapis.com/youtube/v3/channels?part=snippet,status&mine=true", { headers: { Authorization: `Bearer ${t}` } });
      if (!r.items?.length) throw new Error("token OK but no YouTube channel on this Google account");
      return `channel: ${r.items[0].snippet.title}`;
    }, "Connections → Connect Google (YouTube)"));
  if (want("instagram") || process.env.INSTAGRAM_ACCESS_TOKEN)
    checks.push(check("Instagram", async () => {
      const { token, id, host } = await metaToken("instagram");
      const lim = await httpJson<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(`${host}/${id}/content_publishing_limit?fields=quota_usage,config&access_token=${encodeURIComponent(token)}`);
      const d = lim.data?.[0];
      return `publishing quota ${d?.quota_usage ?? "?"}/${d?.config?.quota_total ?? "?"} in last 24h`;
    }, "Connections → Instagram"));
  if (want("facebook") || process.env.FACEBOOK_PAGE_TOKEN)
    checks.push(check("Facebook Page", async () => {
      const { token, id, host } = await metaToken("facebook");
      const p = await httpJson<{ name: string }>(`${host}/${id}?fields=name&access_token=${encodeURIComponent(token)}`);
      return `page: ${p.name}`;
    }, "Connections → Facebook"));
  if (want("threads") || process.env.THREADS_ACCESS_TOKEN)
    checks.push(check("Threads", async () => {
      const { token, host } = await metaToken("threads");
      const me = await httpJson<{ username: string }>(`${host}/me?fields=username&access_token=${encodeURIComponent(token)}`);
      return `@${me.username}`;
    }, "Connections → Threads"));
  if (want("x") || process.env.X_REFRESH_TOKEN)
    checks.push(check("X", async () => {
      const t = await xAccessToken();
      const me = await httpJson<{ data: { username: string } }>("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${t}` } });
      return `@${me.data.username}`;
    }, "Connections → Connect X; check your X API plan allows posting + media upload"));
  if (want("linkedin") || process.env.LINKEDIN_ACCESS_TOKEN)
    checks.push(check("LinkedIn", async () => {
      const { token } = await linkedinAccessToken();
      const me = await httpJson<{ name: string }>("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } });
      const c = conns.linkedin;
      const days = c?.expiresAt ? Math.round((new Date(c.expiresAt).getTime() - Date.now()) / 86400000) : null;
      return `${me.name}${days !== null ? ` — token expires in ${days} days` : ""}`;
    }, "Connections → Connect LinkedIn (tokens last 60 days)"));
  if (want("bluesky") || process.env.BLUESKY_HANDLE)
    checks.push(check("Bluesky", async () => (conns.bluesky?.accountName as string) ?? "connected", "Connections → Bluesky"));
  if (want("telegram") || process.env.TELEGRAM_BOT_TOKEN)
    checks.push(check("Telegram", async () => (conns.telegram?.accountName as string) ?? "connected", "Connections → Telegram"));
  if (want("pinterest") || process.env.PINTEREST_ACCESS_TOKEN)
    checks.push(check("Pinterest", async () => {
      const { token, boardId } = await pinterestToken();
      const b = await httpJson<{ name: string }>(`https://api.pinterest.com/v5/boards/${boardId}`, { headers: { Authorization: `Bearer ${token}` } });
      return `board "${b.name}"`;
    }, "Connections → Pinterest"));
  checks.push(check("Free worker (open-source voice + avatar)", async () => {
    if (!process.env.WORKER_SECRET) throw new Error("WORKER_SECRET not set — free voice/avatar disabled (paid APIs or still-photo fallback only)");
    const q = await queueStats();
    const how = process.env.GH_DISPATCH_TOKEN && process.env.GITHUB_REPO ? `auto-starts on GitHub Actions (${process.env.GITHUB_REPO})` : "no GH_DISPATCH_TOKEN — relies on the 3-hourly schedule or a worker you run yourself";
    return `${how}; queue: ${q.queued} waiting, ${q.running} running`;
  }, "Set WORKER_SECRET in Vercel + GitHub secrets; set GH_DISPATCH_TOKEN + GITHUB_REPO for instant start"));
  return Promise.all(checks);
}
