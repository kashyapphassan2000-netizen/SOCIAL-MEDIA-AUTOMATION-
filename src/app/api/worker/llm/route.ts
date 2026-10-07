import { handle, json, body } from "@/lib/api";
import { requireWorker } from "@/lib/workerAuth";
import { generateJson } from "@/lib/ai/llm";
import { defaultDeps } from "@/lib/engine";
import { getSettings } from "@/lib/db";

export const maxDuration = 180;

/** Lets the Studio app / worker use the app's free LLM chain (e.g. to draft a plugin from a GitHub README). */
export const POST = handle(async (req: Request) => {
  requireWorker(req);
  const { prompt } = await body<{ prompt: string }>(req);
  const s = await getSettings();
  const r = await generateJson(defaultDeps.llms(s), "You are a precise senior ML engineer. Reply with one JSON object only.", String(prompt).slice(0, 60000), (v) => v);
  return json({ text: JSON.stringify(r.data), provider: r.provider });
});
