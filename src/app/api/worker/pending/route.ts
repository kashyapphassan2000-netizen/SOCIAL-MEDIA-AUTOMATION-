import { handle, json } from "@/lib/api";
import { requireWorker } from "@/lib/workerAuth";
import { queueStats } from "@/lib/freeworker";
import { listActiveJobs } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The heartbeat asks which task kinds are waiting, then starts the free worker for just those. */
export const GET = handle(async (req: Request) => {
  await requireWorker(req);
  return json({ ...(await queueStats()), activeJobs: (await listActiveJobs()).length });
});
