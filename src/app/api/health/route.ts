import { requireSession } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { runHealth } from "@/lib/health";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  await requireSession("owner");
  const checks = await runHealth();
  return json({ ok: checks.every((c) => c.ok), checks });
});
