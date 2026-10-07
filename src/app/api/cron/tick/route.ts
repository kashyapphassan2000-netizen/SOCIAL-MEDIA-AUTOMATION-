import { after } from "next/server";
import { isCronRequest, readSession } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { runWorker } from "@/lib/worker";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function run(req: Request) {
  const viaCron = isCronRequest(req);
  const s = viaCron ? null : await readSession();
  if (!viaCron && !s) return json({ error: "unauthorized" }, 401);
  const u = new URL(req.url);
  const depth = Number(u.searchParams.get("depth") ?? 0);
  const waitSec = Number(u.searchParams.get("wait") ?? 0);
  if (u.searchParams.get("async") === "1") {
    // Respond immediately; do the work after the response so the caller never blocks.
    after(() => runWorker({ waitSec, depth }).catch((e) => console.error("worker failed", e)));
    return json({ accepted: true }, 202);
  }
  return json(await runWorker({ depth }));
}

export const GET = handle(run);
export const POST = handle(run);
