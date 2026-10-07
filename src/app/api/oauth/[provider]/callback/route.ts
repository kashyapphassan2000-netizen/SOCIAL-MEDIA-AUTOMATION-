import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { appUrl } from "@/lib/connections";
import { finish, OAUTH_PROVIDERS, type OAuthProvider } from "@/lib/oauth";
import { logActivity } from "@/lib/sheets";

type Ctx = { params: Promise<{ provider: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const p = (await ctx.params).provider as OAuthProvider;
  const u = new URL(req.url);
  const back = (msg: string, ok: boolean) => NextResponse.redirect(`${appUrl()}/?tab=connections&${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
  const s = await readSession();
  if (!s || s.role !== "owner") return back("Sign in as owner first", false);
  if (!OAUTH_PROVIDERS.includes(p)) return back("Unknown provider", false);
  const err = u.searchParams.get("error_description") || u.searchParams.get("error");
  if (err) return back(`${p}: ${err}`, false);
  try {
    const msg = await finish(p, u.searchParams.get("code") ?? "", u.searchParams.get("state") ?? "");
    await logActivity(s, "connection.oauth", msg);
    return back(msg, true);
  } catch (e) {
    return back(`${p}: ${(e as Error).message.slice(0, 300)}`, false);
  }
}
