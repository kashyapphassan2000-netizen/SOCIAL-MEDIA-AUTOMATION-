import { requireSession } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { getSettings, saveSettings } from "@/lib/db";
import { parse, settingsInput } from "@/lib/validation";
import { logActivity } from "@/lib/sheets";
import { AVATAR_REGISTRY } from "@/lib/ai/avatar";
import { VOICE_REGISTRY } from "@/lib/ai/voice";
import { LLM_REGISTRY } from "@/lib/ai/llm";

export const GET = handle(async () => {
  await requireSession();
  return json({
    settings: await getSettings(),
    options: { avatar: Object.keys(AVATAR_REGISTRY), voice: Object.keys(VOICE_REGISTRY), llm: Object.keys(LLM_REGISTRY) },
  });
});

export const PUT = handle(async (req: Request) => {
  const s = await requireSession("owner");
  const next = parse(settingsInput, await body(req));
  const prev = await getSettings();
  // Keep generated look images when the look text did not change.
  next.looks = next.looks.map((l) => {
    const old = prev.looks.find((o) => o.name === l.name && o.prompt === l.prompt);
    return { ...l, imageUrl: old?.imageUrl };
  });
  await saveSettings(next);
  const changed = Object.keys(next).filter((k) => JSON.stringify((next as any)[k]) !== JSON.stringify((prev as any)[k]));
  await logActivity(s, "settings.update", changed.join(", ") || "no changes");
  return json({ settings: next });
});
