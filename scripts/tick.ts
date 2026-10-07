/**
 * Run the worker from any machine (laptop, VPS, GitHub Actions) — a fallback if Vercel is unavailable.
 * Usage: node --env-file=.env.local --import tsx scripts/tick.ts [--loop]
 * Uses the same Redis / Blob / platform credentials as the deployed app.
 */
import { tick } from "../src/lib/engine";

async function main() {
  const loop = process.argv.includes("--loop");
  do {
    const r = await tick({ budgetSec: Number(process.env.WORKER_BUDGET_SEC || 600) });
    console.log(new Date().toISOString(), JSON.stringify(r));
    if (!loop) break;
    const wait = r.nextWakeSec === null ? 600 : Math.max(10, Math.min(r.nextWakeSec, 600));
    await new Promise((res) => setTimeout(res, wait * 1000));
  } while (loop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
