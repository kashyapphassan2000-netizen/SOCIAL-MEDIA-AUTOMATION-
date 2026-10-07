import { HttpError, requireSession } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { getJob, saveJob } from "@/lib/db";
import { logActivity } from "@/lib/sheets";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireSession();
  const j = await getJob((await ctx.params).id);
  if (!j) throw new HttpError(404, "Job not found (finished jobs are kept 7 days — see the Google Sheet)");
  return json({ job: j });
});

/** Cancel: stop work, but still clean up files and write the sheet row. */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const j = await getJob((await ctx.params).id);
  if (!j) throw new HttpError(404, "Job not found");
  if (j.stage === "done") return json({ job: j });
  if (j.stage === "publish" && Object.values(j.data.publish ?? {}).some((r) => r?.state === "done")) {
    throw new HttpError(409, "Already published to at least one platform — cannot cancel now");
  }
  j.status = "failed";
  j.error = `cancelled by ${s.email}`;
  j.stage = "cleanup";
  j.stageAttempts = 0;
  j.nextAttemptAt = undefined;
  j.logs.push({ t: new Date().toISOString(), stage: "cleanup", level: "warn", msg: `Cancelled by ${s.email}` });
  await saveJob(j);
  await logActivity(s, "job.cancel", j.id);
  return json({ job: j });
});
