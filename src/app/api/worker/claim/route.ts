import { handle, json } from "@/lib/api";
import { requireWorker } from "@/lib/workerAuth";
import { claimTask, type FreeTaskKind } from "@/lib/freeworker";

export const dynamic = "force-dynamic";

/** Free worker asks for work. 204 = queue empty. */
export const POST = handle(async (req: Request) => {
  requireWorker(req);
  const body = (await req.json().catch(() => ({}))) as { kinds?: FreeTaskKind[]; worker?: string };
  const kinds = (body.kinds?.length ? body.kinds : ["tts", "avatar"]).filter((k): k is FreeTaskKind => k === "tts" || k === "avatar");
  const t = await claimTask(kinds, String(body.worker ?? "worker").slice(0, 60));
  if (!t) return new Response(null, { status: 204 });
  return json({ task: t });
});
