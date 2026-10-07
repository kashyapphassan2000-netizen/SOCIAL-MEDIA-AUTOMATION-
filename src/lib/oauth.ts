import crypto from "node:crypto";
import { getKV } from "./store/kv";
import { saveConnection } from "./db";
import { appUrl, GOOGLE_SCOPES, GRAPH_VERSION, LINKEDIN_SCOPES, PINTEREST_SCOPES, pinterestBasic, X_SCOPES, xExchange } from "./connections";
import { form, httpJson } from "./http";
import type { Connection } from "./types";

export const OAUTH_PROVIDERS = ["google", "x", "linkedin", "instagram", "threads", "facebook", "pinterest"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

const redirect = (p: OAuthProvider) => `${appUrl()}/api/oauth/${p}/callback`;
const inSec = (s?: number) => (s ? new Date(Date.now() + s * 1000).toISOString() : undefined);
const now = () => new Date().toISOString();

export function oauthEnvMissing(p: OAuthProvider): string[] {
  const need: Record<OAuthProvider, string[]> = {
    google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    x: ["X_CLIENT_ID"],
    linkedin: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    instagram: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
    threads: ["THREADS_APP_ID", "THREADS_APP_SECRET"],
    facebook: ["META_APP_ID", "META_APP_SECRET"],
    pinterest: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
  };
  return need[p].filter((k) => !process.env[k]);
}

export async function startUrl(p: OAuthProvider): Promise<string> {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  await getKV().set(`oauth:${state}`, { p, verifier }, { ttlSec: 900 });
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  switch (p) {
    case "google":
      return `https://accounts.google.com/o/oauth2/v2/auth?${q({
        client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: redirect(p), response_type: "code", scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
      })}`;
    case "x":
      return `https://x.com/i/oauth2/authorize?${q({
        response_type: "code", client_id: process.env.X_CLIENT_ID!, redirect_uri: redirect(p), scope: X_SCOPES.join(" "), state,
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      })}`;
    case "linkedin":
      return `https://www.linkedin.com/oauth/v2/authorization?${q({ response_type: "code", client_id: process.env.LINKEDIN_CLIENT_ID!, redirect_uri: redirect(p), state, scope: LINKEDIN_SCOPES.join(" ") })}`;
    case "instagram":
      return `https://www.instagram.com/oauth/authorize?${q({
        client_id: process.env.INSTAGRAM_APP_ID!, redirect_uri: redirect(p), response_type: "code", state,
        scope: "instagram_business_basic,instagram_business_content_publish",
      })}`;
    case "threads":
      return `https://threads.net/oauth/authorize?${q({ client_id: process.env.THREADS_APP_ID!, redirect_uri: redirect(p), response_type: "code", state, scope: "threads_basic,threads_content_publish" })}`;
    case "facebook":
      return `https://www.facebook.com/${GRAPH_VERSION()}/dialog/oauth?${q({
        client_id: process.env.META_APP_ID!, redirect_uri: redirect(p), state, response_type: "code",
        scope: "pages_show_list,pages_read_engagement,pages_manage_posts,publish_video",
      })}`;
    case "pinterest":
      return `https://www.pinterest.com/oauth/?${q({ client_id: process.env.PINTEREST_APP_ID!, redirect_uri: redirect(p), response_type: "code", scope: PINTEREST_SCOPES.join(","), state })}`;
  }
}

/** Exchange the callback code and store a long-lived connection. Returns a human summary. */
export async function finish(p: OAuthProvider, code: string, state: string): Promise<string> {
  const kv = getKV();
  const st = await kv.get<{ p: string; verifier: string }>(`oauth:${state}`);
  if (!st || st.p !== p) throw new Error("OAuth state expired or invalid — start again");
  await kv.del(`oauth:${state}`);
  let c: Connection;
  switch (p) {
    case "google": {
      const t = await httpJson<{ access_token: string; refresh_token?: string; expires_in: number }>("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: form({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect(p), grant_type: "authorization_code" }),
      });
      if (!t.refresh_token) throw new Error("Google returned no refresh token — remove the app at myaccount.google.com/permissions and connect again");
      const ch = await httpJson<{ items?: { id: string; snippet: { title: string } }[] }>("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: `Bearer ${t.access_token}` },
      }).catch(() => ({ items: [] }));
      c = { platform: "google", accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: inSec(t.expires_in), accountId: ch.items?.[0]?.id, accountName: ch.items?.[0]?.snippet.title ?? "Google account (no YouTube channel found!)", status: "ok", updatedAt: now() };
      break;
    }
    case "x": {
      const t = await xExchange({ grant_type: "authorization_code", code, redirect_uri: redirect(p), code_verifier: st.verifier });
      const me = await httpJson<{ data: { id: string; username: string } }>("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${t.access_token}` } });
      c = { platform: "x", accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: inSec(t.expires_in), accountId: me.data.id, accountName: `@${me.data.username}`, status: "ok", updatedAt: now() };
      break;
    }
    case "linkedin": {
      const t = await httpJson<{ access_token: string; expires_in: number; refresh_token?: string }>("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        body: form({ grant_type: "authorization_code", code, redirect_uri: redirect(p), client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET }),
      });
      const me = await httpJson<{ sub: string; name: string }>("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } });
      c = { platform: "linkedin", accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: inSec(t.expires_in), accountId: `urn:li:person:${me.sub}`, accountName: me.name, status: "ok", updatedAt: now() };
      break;
    }
    case "instagram": {
      const short = await httpJson<{ access_token: string; user_id: number }>("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        body: form({ client_id: process.env.INSTAGRAM_APP_ID, client_secret: process.env.INSTAGRAM_APP_SECRET, grant_type: "authorization_code", redirect_uri: redirect(p), code }),
      });
      const long = await httpJson<{ access_token: string; expires_in: number }>(
        `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${process.env.INSTAGRAM_APP_SECRET}&access_token=${short.access_token}`,
      );
      const me = await httpJson<{ user_id: string; username: string }>(`https://graph.instagram.com/${GRAPH_VERSION()}/me?fields=user_id,username&access_token=${long.access_token}`);
      c = { platform: "instagram", accessToken: long.access_token, expiresAt: inSec(long.expires_in), accountId: String(me.user_id ?? short.user_id), accountName: `@${me.username}`, status: "ok", updatedAt: now() };
      break;
    }
    case "threads": {
      const short = await httpJson<{ access_token: string; user_id: number }>("https://graph.threads.net/oauth/access_token", {
        method: "POST",
        body: form({ client_id: process.env.THREADS_APP_ID, client_secret: process.env.THREADS_APP_SECRET, grant_type: "authorization_code", redirect_uri: redirect(p), code }),
      });
      const long = await httpJson<{ access_token: string; expires_in: number }>(
        `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${process.env.THREADS_APP_SECRET}&access_token=${short.access_token}`,
      );
      const me = await httpJson<{ id: string; username: string }>(`https://graph.threads.net/v1.0/me?fields=id,username&access_token=${long.access_token}`);
      c = { platform: "threads", accessToken: long.access_token, expiresAt: inSec(long.expires_in), accountId: me.id ?? String(short.user_id), accountName: `@${me.username}`, status: "ok", updatedAt: now() };
      break;
    }
    case "facebook": {
      const g = `https://graph.facebook.com/${GRAPH_VERSION()}`;
      const short = await httpJson<{ access_token: string }>(
        `${g}/oauth/access_token?client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&redirect_uri=${encodeURIComponent(redirect(p))}&code=${code}`,
      );
      const long = await httpJson<{ access_token: string }>(
        `${g}/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${short.access_token}`,
      );
      // Page tokens derived from a long-lived user token do not expire.
      const pages = await httpJson<{ data: { id: string; name: string; access_token: string }[] }>(`${g}/me/accounts?fields=id,name,access_token&access_token=${long.access_token}`);
      const page = pages.data.find((x) => x.id === process.env.FACEBOOK_PAGE_ID) ?? pages.data[0];
      if (!page) throw new Error("No Facebook Page found on this account — create a Page first");
      c = { platform: "facebook", accessToken: page.access_token, accountId: page.id, accountName: page.name, status: "ok", updatedAt: now() };
      break;
    }
    case "pinterest": {
      const t = await httpJson<{ access_token: string; refresh_token?: string; expires_in: number }>("https://api.pinterest.com/v5/oauth/token", {
        method: "POST",
        headers: { Authorization: pinterestBasic(), "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "authorization_code", code, redirect_uri: redirect(p) }),
      });
      const H = { Authorization: `Bearer ${t.access_token}` };
      const me = await httpJson<{ username: string }>("https://api.pinterest.com/v5/user_account", { headers: H }).catch(() => ({ username: "" }));
      const boards = await httpJson<{ items: { id: string; name: string }[] }>("https://api.pinterest.com/v5/boards?page_size=50", { headers: H });
      const board = boards.items.find((b) => b.id === process.env.PINTEREST_BOARD_ID) ?? boards.items[0];
      if (!board) throw new Error("No Pinterest board found — create a board first");
      c = { platform: "pinterest", accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: inSec(t.expires_in), accountId: board.id, accountName: `${me.username} → board "${board.name}"`, status: "ok", updatedAt: now() };
      break;
    }
  }
  await saveConnection(c);
  return `${p} connected as ${c.accountName ?? c.accountId}`;
}

/** Manual token paste (Meta App Dashboard "Generate token"). Validates before saving. */
export type ManualPlatform = "instagram" | "facebook" | "threads" | "bluesky" | "telegram";

export async function saveManual(p: ManualPlatform, token: string, accountId?: string): Promise<string> {
  let id = accountId;
  let name = "";
  let expiresAt: string | undefined;
  if (p === "bluesky") {
    // token = app password (Settings -> Privacy and security -> App passwords), accountId = handle
    if (!id) throw new Error("Bluesky handle is required (e.g. yourname.bsky.social)");
    const s = await httpJson<{ handle: string; did: string }>("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: id, password: token }),
      retries: 0,
    });
    name = `@${s.handle}`;
  } else if (p === "telegram") {
    // token = bot token from @BotFather, accountId = @channelusername or -100... id; the bot must be a channel admin
    if (!id) throw new Error("Telegram channel (@username or -100… id) is required");
    const chat = await httpJson<{ ok: boolean; result: { title?: string; username?: string } }>(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(id)}`, { retries: 0 });
    const me = await httpJson<{ result: { id: number } }>(`https://api.telegram.org/bot${token}/getMe`, { retries: 0 });
    const member = await httpJson<{ result: { status: string } }>(`https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(id)}&user_id=${me.result.id}`, { retries: 0 });
    if (!["administrator", "creator"].includes(member.result.status)) throw new Error("Make the bot an admin of the channel (with 'Post messages') first");
    name = chat.result.title ?? chat.result.username ?? id;
  } else if (p === "instagram") {
    const host = token.startsWith("IG") ? `https://graph.instagram.com/${GRAPH_VERSION()}` : `https://graph.facebook.com/${GRAPH_VERSION()}`;
    if (token.startsWith("IG")) {
      const me = await httpJson<{ user_id: string; username: string }>(`${host}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
      id = id || String(me.user_id);
      name = `@${me.username}`;
      expiresAt = inSec(55 * 24 * 3600);
    } else {
      if (!id) throw new Error("Instagram business account id is required for Facebook-login tokens");
      const me = await httpJson<{ username: string }>(`${host}/${id}?fields=username&access_token=${encodeURIComponent(token)}`);
      name = `@${me.username}`;
    }
  } else if (p === "threads") {
    const me = await httpJson<{ id: string; username: string }>(`https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(token)}`);
    id = id || me.id;
    name = `@${me.username}`;
    expiresAt = inSec(55 * 24 * 3600);
  } else {
    if (!id) throw new Error("Facebook Page id is required");
    const me = await httpJson<{ name: string }>(`https://graph.facebook.com/${GRAPH_VERSION()}/${id}?fields=name&access_token=${encodeURIComponent(token)}`);
    name = me.name;
  }
  await saveConnection({ platform: p, accessToken: token, accountId: id, accountName: name, expiresAt, status: "ok", updatedAt: now() });
  return `${p} connected as ${name}`;
}
