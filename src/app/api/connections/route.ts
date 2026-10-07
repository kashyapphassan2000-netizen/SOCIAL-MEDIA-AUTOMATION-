import { HttpError, requireSession } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { deleteConnection, listConnections } from "@/lib/db";
import { OAUTH_PROVIDERS, oauthEnvMissing, saveManual, type ManualPlatform } from "@/lib/oauth";
import { appUrl } from "@/lib/connections";
import { logActivity } from "@/lib/sheets";

export const GET = handle(async () => {
  await requireSession();
  const missing = Object.fromEntries(OAUTH_PROVIDERS.map((p) => [p, oauthEnvMissing(p)]));
  return json({ connections: await listConnections(), oauthMissing: missing, redirectBase: `${appUrl()}/api/oauth` });
});

/** Manual Meta token paste. */
export const POST = handle(async (req: Request) => {
  const s = await requireSession("owner");
  const { platform, token, accountId } = await body<{ platform: ManualPlatform; token: string; accountId?: string }>(req);
  if (!["instagram", "facebook", "threads", "bluesky", "telegram"].includes(platform) || !token) throw new HttpError(400, "platform and token required");
  const msg = await saveManual(platform, token.trim(), accountId?.trim() || undefined);
  await logActivity(s, "connection.manual", msg);
  return json({ ok: true, message: msg });
});

export const DELETE = handle(async (req: Request) => {
  const s = await requireSession("owner");
  const p = new URL(req.url).searchParams.get("platform");
  if (!p) throw new HttpError(400, "platform required");
  await deleteConnection(p as never);
  await logActivity(s, "connection.remove", p);
  return json({ ok: true });
});
