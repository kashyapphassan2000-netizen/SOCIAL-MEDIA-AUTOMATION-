import { HttpError, requireSession } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { addOutlet, deliver, listOutlets, outletView, removeOutlet } from "@/lib/outlets";
import { logActivity } from "@/lib/sheets";
import { PLATFORMS, type Platform } from "@/lib/types";

/** "Any network" webhook outlets: list, add (returns the signing secret ONCE), send a test, remove. */
export const GET = handle(async () => {
  await requireSession("owner");
  return json({ outlets: (await listOutlets()).map(outletView) });
});

export const POST = handle(async (req: Request) => {
  const who = await requireSession("owner");
  const b = await body<{ name?: string; url?: string; captionStyle?: string; testId?: string }>(req);
  if (b.testId) {
    const o = (await listOutlets()).find((x) => x.id === b.testId);
    if (!o) throw new HttpError(404, "outlet not found");
    const r = await deliver(o, { event: "test", message: "Shorts Autopilot test delivery", videoUrl: null });
    return json(r);
  }
  if (!b.url) throw new HttpError(400, "url required");
  const style = PLATFORMS.includes(b.captionStyle as Platform) ? (b.captionStyle as Platform) : undefined;
  try {
    const { outlet, secret } = await addOutlet({ name: b.name ?? "", url: b.url, captionStyle: style });
    await logActivity(who, "outlet.add", `${outlet.name} → ${new URL(outlet.url).host}`);
    return json({ outlet: outletView(outlet), secret }, 201);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

export const DELETE = handle(async (req: Request) => {
  const who = await requireSession("owner");
  const id = new URL(req.url).searchParams.get("id") ?? "";
  await removeOutlet(id);
  await logActivity(who, "outlet.remove", id);
  return json({ ok: true });
});
