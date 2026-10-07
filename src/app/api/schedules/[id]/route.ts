import { HttpError, requireSession } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { deleteSchedule, getSchedule, saveSchedule } from "@/lib/db";
import { parse, scheduleInput } from "@/lib/validation";
import { logActivity } from "@/lib/sheets";
import type { Session } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

async function load(id: string, s: Session) {
  const sch = await getSchedule(id);
  if (!sch) throw new HttpError(404, "Schedule not found");
  // Users manage their own schedules; the owner manages everything.
  if (s.role !== "owner" && sch.createdBy !== s.email) throw new HttpError(403, "You can only change schedules you created");
  return sch;
}

export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const sch = await load((await ctx.params).id, s);
  const input = parse(scheduleInput, await body(req));
  const next = { ...sch, ...input, updatedAt: new Date().toISOString() };
  await saveSchedule(next);
  await logActivity(s, "schedule.update", `${next.name}: enabled=${next.enabled}, every ${next.everyHours}h, ${next.platforms.join(", ")}`);
  return json({ schedule: next });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const sch = await load((await ctx.params).id, s);
  await deleteSchedule(sch.id);
  await logActivity(s, "schedule.delete", sch.name);
  return json({ ok: true });
});
