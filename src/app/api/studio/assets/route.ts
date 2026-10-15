import { HttpError, requireSession } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { getAssets } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { addMusicTrack, addPerformanceClip, removeClip, removeMusicTrack, setPhoto, setVoiceClip } from "@/lib/studio";
import { logActivity } from "@/lib/sheets";

export const maxDuration = 120;

export const GET = handle(async () => {
  await requireSession();
  const a = await getAssets();
  return json({ assets: { ...a, elevenVoiceId: a.elevenVoiceId ? "set" : undefined }, blobUploads: !!process.env.BLOB_READ_WRITE_TOKEN });
});

/** Body: JSON {kind, url} after a client Blob upload, or multipart {kind, file} (local dev / small files). */
export const POST = handle(async (req: Request) => {
  const s = await requireSession();
  let kind: string;
  let url: string;
  let name = "";
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const fd = await req.formData();
    kind = String(fd.get("kind"));
    name = String(fd.get("name") ?? "");
    const f = fd.get("file");
    if (!(f instanceof File)) throw new HttpError(400, "file missing");
    url = await getStorage().put(`assets/${f.name}`, Buffer.from(await f.arrayBuffer()), f.type || "application/octet-stream");
  } else {
    ({ kind, url, name = "" } = (await req.json()) as { kind: string; url: string; name?: string });
  }
  if (!url) throw new HttpError(400, "url missing");
  if (kind === "photo") {
    const assets = await setPhoto(url, s.email);
    await logActivity(s, "studio.photo", "New creator photo uploaded (outfit looks will regenerate)");
    return json({ assets, notes: ["Photo saved. Outfit looks will be regenerated from it on the next videos."] });
  }
  if (kind === "clip") {
    const r = await setVoiceClip(url, s.email);
    await logActivity(s, "studio.voice", `Voice clip processed. ${r.notes.join(" ")}`);
    return json(r);
  }
  if (kind === "performance") {
    const r = await addPerformanceClip(url, name, s.email);
    await logActivity(s, "studio.performance_clip", r.notes.join(" "));
    return json(r);
  }
  if (kind === "music") {
    const r = await addMusicTrack(url, name, s.email);
    await logActivity(s, "studio.music", name);
    return json(r);
  }
  throw new HttpError(400, "kind must be photo, clip, performance or music");
});

export const DELETE = handle(async (req: Request) => {
  const s = await requireSession();
  const q = new URL(req.url).searchParams;
  const track = q.get("music");
  if (track) return json({ assets: await removeMusicTrack(track, s.email) });
  const url = q.get("clip");
  if (!url) throw new HttpError(400, "clip url required");
  const assets = await removeClip(url);
  await logActivity(s, "studio.remove_clip", url);
  return json({ assets });
});
