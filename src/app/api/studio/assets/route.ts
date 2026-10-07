import { HttpError, requireSession } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { getAssets } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { setPhoto, setVoiceClip } from "@/lib/studio";
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
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const fd = await req.formData();
    kind = String(fd.get("kind"));
    const f = fd.get("file");
    if (!(f instanceof File)) throw new HttpError(400, "file missing");
    url = await getStorage().put(`assets/${f.name}`, Buffer.from(await f.arrayBuffer()), f.type || "application/octet-stream");
  } else {
    ({ kind, url } = (await req.json()) as { kind: string; url: string });
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
  throw new HttpError(400, "kind must be photo or clip");
});
