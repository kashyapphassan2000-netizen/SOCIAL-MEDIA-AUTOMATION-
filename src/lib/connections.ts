import { SignJWT, importPKCS8 } from "jose";
import { getConnection, saveConnection } from "./db";
import { form, HttpFailure, httpJson } from "./http";
import type { Connection, Platform } from "./types";

export class ReauthRequired extends Error {
  constructor(public platform: string, msg: string) {
    super(`${platform}: reconnect required — ${msg}`);
  }
}

export const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION || "v23.0";

export function appUrl(): string {
  const u = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
  return u.replace(/\/$/, "");
}

const soon = (iso?: string, slackSec = 300) => !iso || new Date(iso).getTime() - Date.now() < slackSec * 1000;
const inSec = (s: number) => new Date(Date.now() + s * 1000).toISOString();

async function markBroken(c: Connection, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await saveConnection({ ...c, status: "needs_reauth", lastError: msg.slice(0, 400) });
  return new ReauthRequired(c.platform, msg.slice(0, 200));
}

/** Env-provided tokens let the owner bootstrap without clicking through OAuth (and act as a backup). */
function envConnection(p: Connection["platform"]): Connection | null {
  const now = new Date().toISOString();
  switch (p) {
    case "google":
      return process.env.GOOGLE_REFRESH_TOKEN ? { platform: p, refreshToken: process.env.GOOGLE_REFRESH_TOKEN, status: "ok", updatedAt: now } : null;
    case "instagram":
      return process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID
        ? { platform: p, accessToken: process.env.INSTAGRAM_ACCESS_TOKEN, accountId: process.env.INSTAGRAM_USER_ID, status: "ok", updatedAt: now }
        : null;
    case "facebook":
      return process.env.FACEBOOK_PAGE_TOKEN && process.env.FACEBOOK_PAGE_ID
        ? { platform: p, accessToken: process.env.FACEBOOK_PAGE_TOKEN, accountId: process.env.FACEBOOK_PAGE_ID, status: "ok", updatedAt: now }
        : null;
    case "threads":
      return process.env.THREADS_ACCESS_TOKEN && process.env.THREADS_USER_ID
        ? { platform: p, accessToken: process.env.THREADS_ACCESS_TOKEN, accountId: process.env.THREADS_USER_ID, status: "ok", updatedAt: now }
        : null;
    case "x":
      return process.env.X_REFRESH_TOKEN ? { platform: p, refreshToken: process.env.X_REFRESH_TOKEN, status: "ok", updatedAt: now } : null;
    case "linkedin":
      return process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_PERSON_URN
        ? { platform: p, accessToken: process.env.LINKEDIN_ACCESS_TOKEN, accountId: process.env.LINKEDIN_PERSON_URN, status: "ok", updatedAt: now }
        : null;
    case "pinterest":
      return process.env.PINTEREST_ACCESS_TOKEN
        ? { platform: p, accessToken: process.env.PINTEREST_ACCESS_TOKEN, refreshToken: process.env.PINTEREST_REFRESH_TOKEN, accountId: process.env.PINTEREST_BOARD_ID, status: "ok", updatedAt: now }
        : null;
    case "bluesky":
      return process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD
        ? { platform: p, accountId: process.env.BLUESKY_HANDLE, accessToken: process.env.BLUESKY_APP_PASSWORD, status: "ok", updatedAt: now }
        : null;
    case "telegram":
      return process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
        ? { platform: p, accessToken: process.env.TELEGRAM_BOT_TOKEN, accountId: process.env.TELEGRAM_CHAT_ID, status: "ok", updatedAt: now }
        : null;
    default:
      return null;
  }
}

export async function loadConnection(p: Connection["platform"]): Promise<Connection | null> {
  return (await getConnection(p)) ?? envConnection(p);
}

// ---------------- Google (YouTube + Sheets) ----------------
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl", // post the first comment
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "email",
];

export async function googleAccessToken(): Promise<string> {
  const c = await loadConnection("google");
  if (!c?.refreshToken) throw new ReauthRequired("google", "Google account not connected");
  if (c.accessToken && !soon(c.expiresAt)) return c.accessToken;
  try {
    const t = await httpJson<{ access_token: string; expires_in: number }>("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: form({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: c.refreshToken,
        grant_type: "refresh_token",
      }),
      retries: 2,
    });
    await saveConnection({ ...c, accessToken: t.access_token, expiresAt: inSec(t.expires_in), status: "ok", lastError: undefined });
    return t.access_token;
  } catch (e) {
    if (e instanceof HttpFailure && e.status === 400 && e.body.includes("invalid_grant")) throw await markBroken(c, e);
    throw e;
  }
}

/** Optional service account for Sheets (independent of the YouTube login). */
export async function serviceAccountToken(scope: string): Promise<string | null> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const json = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
  const key = await importPKCS8(json.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(json.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const t = await httpJson<{ access_token: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: form({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  return t.access_token;
}

// ---------------- X (OAuth 2.0, rotating refresh tokens) ----------------
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];

function xBasicAuth(): Record<string, string> {
  const id = process.env.X_CLIENT_ID ?? "";
  const sec = process.env.X_CLIENT_SECRET;
  return sec ? { Authorization: `Basic ${Buffer.from(`${id}:${sec}`).toString("base64")}` } : {};
}

export async function xExchange(params: Record<string, string>) {
  return httpJson<{ access_token: string; refresh_token?: string; expires_in: number }>("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...xBasicAuth() },
    body: form({ client_id: process.env.X_CLIENT_ID, ...params }),
    retries: 1,
  });
}

export async function xAccessToken(): Promise<string> {
  const c = await loadConnection("x");
  if (!c?.refreshToken && !c?.accessToken) throw new ReauthRequired("x", "X account not connected");
  if (c.accessToken && !soon(c.expiresAt)) return c.accessToken;
  if (!c.refreshToken) throw await markBroken(c, "access token expired and no refresh token");
  try {
    const t = await xExchange({ grant_type: "refresh_token", refresh_token: c.refreshToken });
    // X rotates refresh tokens: persist the new one immediately or the next refresh fails.
    await saveConnection({ ...c, accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken, expiresAt: inSec(t.expires_in), status: "ok", lastError: undefined });
    return t.access_token;
  } catch (e) {
    if (e instanceof HttpFailure && (e.status === 400 || e.status === 401)) throw await markBroken(c, e);
    throw e;
  }
}

// ---------------- LinkedIn (60-day tokens; refresh only for approved apps) ----------------
export const LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"];

export async function linkedinAccessToken(): Promise<{ token: string; author: string }> {
  const c = await loadConnection("linkedin");
  if (!c?.accessToken || !c.accountId) throw new ReauthRequired("linkedin", "LinkedIn not connected");
  if (c.expiresAt && soon(c.expiresAt, 0)) {
    if (c.refreshToken) {
      const t = await httpJson<{ access_token: string; expires_in: number; refresh_token?: string }>("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        body: form({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET }),
      }).catch(async (e) => {
        throw await markBroken(c, e);
      });
      await saveConnection({ ...c, accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken, expiresAt: inSec(t.expires_in), status: "ok" });
      return { token: t.access_token, author: c.accountId };
    }
    throw await markBroken(c, "LinkedIn token expired (60-day limit) — reconnect");
  }
  return { token: c.accessToken, author: c.accountId };
}

// ---------------- Meta long-lived tokens (Instagram / Threads auto-refresh, FB page tokens don't expire) ----------------
export async function metaToken(p: "instagram" | "facebook" | "threads"): Promise<{ token: string; id: string; host: string }> {
  const c = await loadConnection(p);
  if (!c?.accessToken || !c.accountId) throw new ReauthRequired(p, `${p} not connected`);
  let token = c.accessToken;
  // Long-lived IG/Threads tokens last 60 days; refresh when older than ~7 days of remaining life.
  const refreshDue = !c.expiresAt || soon(c.expiresAt, 7 * 24 * 3600);
  if (refreshDue && p !== "facebook") {
    try {
      const url =
        p === "threads"
          ? `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`
          : `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
      if (p === "threads" || token.startsWith("IG")) {
        const t = await httpJson<{ access_token: string; expires_in: number }>(url, { retries: 1 });
        token = t.access_token;
        await saveConnection({ ...c, accessToken: token, expiresAt: inSec(t.expires_in), status: "ok", lastError: undefined });
      }
    } catch (e) {
      // A failed refresh is not fatal while the current token still works; record it so the dashboard shows it.
      if (c.expiresAt && soon(c.expiresAt, 0)) throw await markBroken(c, e);
      await saveConnection({ ...c, lastError: `refresh failed: ${String((e as Error).message).slice(0, 200)}` });
    }
  }
  const host =
    p === "threads" ? "https://graph.threads.net/v1.0" : p === "instagram" && token.startsWith("IG") ? `https://graph.instagram.com/${GRAPH_VERSION()}` : `https://graph.facebook.com/${GRAPH_VERSION()}`;
  return { token, id: c.accountId, host };
}

// ---------------- Pinterest (30-day access tokens, refreshable) ----------------
export const PINTEREST_SCOPES = ["boards:read", "pins:read", "pins:write", "user_accounts:read"];

export function pinterestBasic() {
  return `Basic ${Buffer.from(`${process.env.PINTEREST_APP_ID}:${process.env.PINTEREST_APP_SECRET}`).toString("base64")}`;
}

export async function pinterestToken(): Promise<{ token: string; boardId: string }> {
  const c = await loadConnection("pinterest");
  if (!c?.accessToken) throw new ReauthRequired("pinterest", "Pinterest not connected");
  const boardId = c.accountId || process.env.PINTEREST_BOARD_ID;
  if (!boardId) throw new ReauthRequired("pinterest", "no Pinterest board selected (set PINTEREST_BOARD_ID)");
  if (c.expiresAt && soon(c.expiresAt, 24 * 3600) && c.refreshToken) {
    try {
      const t = await httpJson<{ access_token: string; expires_in: number; refresh_token?: string }>("https://api.pinterest.com/v5/oauth/token", {
        method: "POST",
        headers: { Authorization: pinterestBasic(), "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "refresh_token", refresh_token: c.refreshToken }),
      });
      await saveConnection({ ...c, accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken, expiresAt: inSec(t.expires_in), status: "ok", lastError: undefined });
      return { token: t.access_token, boardId };
    } catch (e) {
      if (soon(c.expiresAt, 0)) throw await markBroken(c, e);
    }
  }
  return { token: c.accessToken, boardId };
}

export function isConfigured(p: Platform): boolean {
  switch (p) {
    case "youtube":
      return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    case "x":
      return !!process.env.X_CLIENT_ID;
    case "linkedin":
      return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
    default:
      return true; // Meta tokens are pasted in the dashboard
  }
}
