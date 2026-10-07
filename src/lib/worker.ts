import { after } from "next/server";
import { tick, type TickResult } from "./engine";
import { appUrl } from "./connections";
import { sleep } from "./http";

const MAX_CHAIN = 40;

/**
 * Self-continuation: Vercel cron (daily on Hobby) and GitHub Actions (every ~10 min) are coarse triggers.
 * When jobs are waiting on an avatar render or platform processing, the worker re-invokes itself so a
 * video goes from idea to posted in ~5-15 minutes instead of waiting for the next external trigger.
 */
export function chainNext(r: TickResult, depth: number) {
  if (r.status !== "ok" || r.nextWakeSec === null || r.nextWakeSec > 600 || depth >= MAX_CHAIN) return false;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = `${appUrl()}/api/cron/tick?async=1&wait=${Math.min(r.nextWakeSec, 90)}&depth=${depth + 1}`;
  after(async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      await fetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: ctrl.signal }).catch(() => undefined);
      clearTimeout(t);
    } catch {
      /* the external cron is the safety net */
    }
  });
  return true;
}

export async function runWorker(opts: { waitSec?: number; depth: number; budgetSec?: number }) {
  const wait = Math.min(Math.max(0, opts.waitSec ?? 0), 90);
  if (wait) await sleep(wait * 1000);
  // Sleeping eats into maxDuration; keep enough budget left for a full render (~150s).
  const budget = opts.budgetSec ?? Number(process.env.WORKER_BUDGET_SEC || 270) - wait;
  const r = await tick({ budgetSec: Math.max(30, budget) });
  const chained = chainNext(r, opts.depth);
  return { ...r, chained };
}
