import { HttpError, requireSession } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { getSettings, saveSettings } from "@/lib/db";
import { addProvider, listCustom, publicView, removeProvider, testProvider } from "@/lib/ai/custom";
import { LLM_REGISTRY } from "@/lib/ai/llm";
import { logActivity } from "@/lib/sheets";

export const maxDuration = 120;

/** Plug-and-play AI brain: list, connect (detect + test + make first choice), test, remove. */
export const GET = handle(async () => {
  await requireSession("owner");
  const s = await getSettings();
  const builtIn = Object.keys(LLM_REGISTRY).filter((k) => !k.startsWith("custom:")).map((k) => ({ name: k, available: LLM_REGISTRY[k].available() }));
  return json({ custom: (await listCustom()).map(publicView), builtIn, order: s.llmProviders });
});

export const POST = handle(async (req: Request) => {
  const who = await requireSession("owner");
  const b = await body<{ key?: string; baseUrl?: string; model?: string; label?: string; testOnly?: boolean }>(req);
  if (!b.key?.trim() && !b.baseUrl?.trim()) throw new HttpError(400, "Paste an API key (or a base URL for a local model server)");
  try {
    if (b.testOnly) return json({ ok: true, ...(await testProvider({ key: b.key ?? "", baseUrl: b.baseUrl, model: b.model })) });
    const c = await addProvider({ key: b.key ?? "", baseUrl: b.baseUrl, model: b.model, label: b.label });
    // Only the AI changes: the new brain goes first; everything else keeps working as before.
    const s = await getSettings();
    const name = `custom:${c.id}`;
    await saveSettings({ ...s, llmProviders: [name, ...s.llmProviders.filter((n) => n !== name)] });
    await logActivity(who, "llm.connect", `${c.label} · ${c.model}`);
    return json({ ok: true, provider: publicView(c) }, 201);
  } catch (e) {
    throw new HttpError(400, `Could not connect: ${(e as Error).message.slice(0, 300)}`);
  }
});

export const DELETE = handle(async (req: Request) => {
  const who = await requireSession("owner");
  const id = new URL(req.url).searchParams.get("id") ?? "";
  await removeProvider(id);
  const s = await getSettings();
  await saveSettings({ ...s, llmProviders: s.llmProviders.filter((n) => n !== `custom:${id}`) });
  await logActivity(who, "llm.remove", id);
  return json({ ok: true });
});
