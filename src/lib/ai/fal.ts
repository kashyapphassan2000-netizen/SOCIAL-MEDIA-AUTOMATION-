import { httpJson, sleep } from "../http";

/** fal.ai queue API: submit -> poll status_url -> read response_url. */
export interface FalSubmit {
  request_id: string;
  status_url: string;
  response_url: string;
}

const auth = () => ({ Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" });

export function falAvailable() {
  return !!process.env.FAL_KEY;
}

export async function falSubmit(model: string, input: Record<string, unknown>): Promise<FalSubmit> {
  return httpJson<FalSubmit>(`https://queue.fal.run/${model}`, { method: "POST", headers: auth(), body: JSON.stringify(input), timeoutMs: 30_000 });
}

export type FalStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | string;

export async function falStatus(statusUrl: string): Promise<{ status: FalStatus; error?: string }> {
  const r = await httpJson<any>(statusUrl, { headers: auth(), timeoutMs: 20_000 });
  return { status: r.status, error: r.error };
}

export async function falResult<T = any>(responseUrl: string): Promise<T> {
  const r = await httpJson<any>(responseUrl, { headers: auth(), timeoutMs: 30_000, retries: 1 });
  if (r?.detail && !r.video && !r.audio_url && !r.images) throw new Error(`fal error: ${JSON.stringify(r.detail).slice(0, 300)}`);
  return r as T;
}

/** For fast models (TTS, image edits): submit and poll until done or timeout. */
export async function falRun<T = any>(model: string, input: Record<string, unknown>, timeoutMs = 150_000): Promise<T> {
  const sub = await falSubmit(model, input);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2500);
    const s = await falStatus(sub.status_url);
    if (s.status === "COMPLETED") return falResult<T>(sub.response_url);
    if (s.status === "FAILED" || s.error) throw new Error(`fal ${model} failed: ${s.error ?? "unknown"}`);
  }
  throw new Error(`fal ${model} timed out after ${timeoutMs / 1000}s`);
}
