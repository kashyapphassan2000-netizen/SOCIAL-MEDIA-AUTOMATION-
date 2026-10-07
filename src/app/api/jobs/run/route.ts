import { HttpError, requireSession } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { getSchedule } from "@/lib/db";
import { createJob } from "@/lib/engine";
import { logActivity } from "@/lib/sheets";
import { chainNext } from "@/lib/worker";

export const maxDuration = 60;

/** "Make one now": create a job for a schedule and kick the worker in the background. */
export const POST = handle(async (req: Request) => {
  const s = await requireSession();
  const { scheduleId } = await body<{ scheduleId: string }>(req);
  const sch = await getSchedule(scheduleId);
  if (!sch) throw new HttpError(404, "Schedule not found");
  const job = await createJob(sch, "manual", s.email);
  await logActivity(s, "job.run_now", `${sch.name} → ${job.id}`);
  const kicked = chainNext({ status: "ok", created: 1, steps: 0, activeJobs: 1, nextWakeSec: 0, flushed: 0 }, 0);
  return json({ job, kicked, note: kicked ? undefined : "CRON_SECRET not set — the job will start on the next cron tick" }, 201);
});
