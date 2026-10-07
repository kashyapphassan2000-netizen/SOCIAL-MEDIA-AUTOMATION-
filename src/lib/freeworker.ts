import { getKV } from "./store/kv";
import { newId } from "./crypto";
import { http } from "./http";

/**
 * Zero-cost GPU/CPU offload. The app queues "tts" / "avatar" tasks here; a worker running
 * open-source models (worker/free_worker.py: Chatterbox voice clone, SadTalker talking head)
 * claims them over HTTP, renders, and uploads the result. The worker can run on GitHub Actions
 * (free), Kaggle (30 free GPU h/week), Google Colab, or your own PC — anything with Python.
 */
export type FreeTaskKind = "tts" | "avatar" | "lipsync";

export interface FreeTask {
  id: string;
  kind: FreeTaskKind;
  status: "queued" | "claimed" | "done" | "failed";
  input: Record<string, string | number>;
  outputUrl?: string;
  meta?: Record<string, unknown>;
  error?: string;
  attempts: number;
  createdAt: string;
  claimedAt?: string;
  finishedAt?: string;
  worker?: string;
}

const KEY = (id: string) => `ftask:${id}`;
const QUEUE = "ftasks:open";
const LEASE_MIN = 45;
const MAX_ATTEMPTS = 2;
const TTL = 3 * 24 * 3600;

export function freeWorkerEnabled(): boolean {
  return !!process.env.WORKER_SECRET;
}

export async function enqueueTask(kind: FreeTaskKind, input: FreeTask["input"]): Promise<FreeTask> {
  const t: FreeTask = { id: newId("ft"), kind, status: "queued", input, attempts: 0, createdAt: new Date().toISOString() };
  const kv = getKV();
  await kv.set(KEY(t.id), t, { ttlSec: TTL });
  await kv.sadd(QUEUE, t.id);
  await dispatchWorker(kind).catch(() => undefined); // the scheduled run is the safety net
  return t;
}

export async function getTask(id: string) {
  return getKV().get<FreeTask>(KEY(id));
}

async function save(t: FreeTask) {
  const kv = getKV();
  await kv.set(KEY(t.id), t, { ttlSec: TTL });
  if (t.status === "done" || t.status === "failed") await kv.srem(QUEUE, t.id);
}

/** Oldest queued task (or one whose worker died and whose lease expired). */
export async function claimTask(kinds: FreeTaskKind[], worker: string): Promise<FreeTask | null> {
  const kv = getKV();
  const ids = await kv.smembers(QUEUE);
  const tasks = (await Promise.all(ids.map((id) => getTask(id)))).filter((t): t is FreeTask => !!t);
  for (const [i, id] of ids.entries()) if (!tasks.find((t) => t.id === id)) await kv.srem(QUEUE, ids[i]);
  const now = Date.now();
  const candidates = tasks
    .filter((t) => kinds.includes(t.kind))
    .filter((t) => t.status === "queued" || (t.status === "claimed" && now - new Date(t.claimedAt ?? 0).getTime() > LEASE_MIN * 60_000))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const t of candidates) {
    if (t.attempts >= MAX_ATTEMPTS) {
      await save({ ...t, status: "failed", error: t.error ?? "worker lease expired twice (worker crashed or too slow)", finishedAt: new Date().toISOString() });
      continue;
    }
    // Per-task lock so two workers never take the same task.
    if (!(await kv.setNx(`ftask:lock:${t.id}`, worker, 60))) continue;
    const claimed: FreeTask = { ...t, status: "claimed", claimedAt: new Date().toISOString(), attempts: t.attempts + 1, worker };
    await save(claimed);
    return claimed;
  }
  return null;
}

export async function completeTask(id: string, r: { outputUrl?: string; error?: string; meta?: Record<string, unknown> }) {
  const t = await getTask(id);
  if (!t) throw new Error("task not found");
  await save({ ...t, status: r.error ? "failed" : "done", outputUrl: r.outputUrl, error: r.error, meta: r.meta, finishedAt: new Date().toISOString() });
}

export async function queueStats() {
  const ids = await getKV().smembers(QUEUE);
  const tasks = (await Promise.all(ids.map((id) => getTask(id)))).filter((t): t is FreeTask => !!t);
  return { queued: tasks.filter((t) => t.status === "queued").length, running: tasks.filter((t) => t.status === "claimed").length };
}

/** Start the GitHub Actions worker right away instead of waiting for its schedule. */
export async function dispatchWorker(kind: FreeTaskKind): Promise<boolean> {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO; // "owner/name"
  if (!token || !repo) return false;
  const kv = getKV();
  // A running worker drains the whole queue, so one dispatch per kind every few minutes is enough.
  if (!(await kv.setNx(`ftask:dispatched:${kind}`, "1", 240))) return true;
  await http(`https://api.github.com/repos/${repo}/actions/workflows/${process.env.GITHUB_WORKER_WORKFLOW || "free-worker.yml"}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    // Vercel exposes the deployed branch; the workflow must be dispatched on a branch that contains it.
    body: JSON.stringify({ ref: process.env.GITHUB_WORKER_REF || process.env.VERCEL_GIT_COMMIT_REF || "main", inputs: { kinds: kind } }),
    retries: 1,
  });
  return true;
}
