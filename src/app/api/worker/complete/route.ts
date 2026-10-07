import { HttpError } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { requireWorker } from "@/lib/workerAuth";
import { completeTask, getTask } from "@/lib/freeworker";
import { getStorage } from "@/lib/storage";
import { chainNext } from "@/lib/worker";

export const maxDuration = 60;

/**
 * Free worker uploads its result (multipart: taskId, file | error, meta JSON).
 * Vercel caps request bodies at 4.5 MB — the worker compresses outputs below that.
 */
export const POST = handle(async (req: Request) => {
  requireWorker(req);
  const fd = await req.formData();
  const id = String(fd.get("taskId") ?? "");
  const t = await getTask(id);
  if (!t) throw new HttpError(404, "task not found");
  const error = fd.get("error");
  const meta = (() => {
    try {
      return JSON.parse(String(fd.get("meta") ?? "{}")) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  if (error) {
    await completeTask(id, { error: String(error).slice(0, 1000), meta });
  } else {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size < 1000) throw new HttpError(400, "file missing or empty");
    const ext = t.kind === "tts" ? (f.name.endsWith(".wav") ? "wav" : "mp3") : "mp4";
    const url = await getStorage().put(`free/${id}.${ext}`, Buffer.from(await f.arrayBuffer()), f.type || (ext === "mp4" ? "video/mp4" : "audio/mpeg"));
    await completeTask(id, { outputUrl: url, meta });
  }
  // Wake the pipeline immediately instead of waiting for the next heartbeat.
  chainNext({ status: "ok", created: 0, steps: 0, activeJobs: 1, nextWakeSec: 0, flushed: 0 }, 0);
  return json({ ok: true });
});
