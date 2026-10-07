import { NextResponse } from "next/server";
import { HttpError, requireSession } from "@/lib/auth";
import { handle } from "@/lib/api";
import { OAUTH_PROVIDERS, oauthEnvMissing, startUrl, type OAuthProvider } from "@/lib/oauth";

type Ctx = { params: Promise<{ provider: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireSession("owner");
  const p = (await ctx.params).provider as OAuthProvider;
  if (!OAUTH_PROVIDERS.includes(p)) throw new HttpError(404, "Unknown provider");
  const missing = oauthEnvMissing(p);
  if (missing.length) throw new HttpError(400, `Set ${missing.join(", ")} in Vercel env first`);
  return NextResponse.redirect(await startUrl(p));
});
