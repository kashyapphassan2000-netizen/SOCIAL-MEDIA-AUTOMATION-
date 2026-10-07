import { requireSession } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { listSchedules, saveSchedule } from "@/lib/db";
import { newId } from "@/lib/crypto";
import { parse, scheduleInput } from "@/lib/validation";
import { logActivity } from "@/lib/sheets";
import type { Schedule } from "@/lib/types";

export const GET = handle(async () => {
  await requireSession();
  return json({ schedules: await listSchedules() });
});

export const POST = handle(async (req: Request) => {
  const s = await requireSession();
  const input = parse(scheduleInput, await body(req));
  const now = new Date().toISOString();
  const sch: Schedule = { ...input, id: newId("sch"), createdBy: s.email, createdAt: now, updatedAt: now };
  await saveSchedule(sch);
  await logActivity(s, "schedule.create", `${sch.name}: "${sch.topic}" every ${sch.everyHours}h → ${sch.platforms.join(", ")} (${sch.publishMode})`);
  return json({ schedule: sch }, 201);
});
