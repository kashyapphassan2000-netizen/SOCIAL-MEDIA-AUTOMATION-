import { requireSession } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { getDayCount, getSettings, listRecentJobs } from "@/lib/db";
import { getKV } from "@/lib/store/kv";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  await requireSession();
  const s = await getSettings();
  const jobs = await listRecentJobs(40);
  return json({
    jobs: jobs.map((j) => ({ ...j, logs: j.logs.slice(-40) })),
    today: { videos: await getDayCount("videos", s.timezone), cap: s.maxVideosPerDay },
    blocked: await getKV().get<{ at: string; problems: string[] }>("worker:blocked"),
  });
});
