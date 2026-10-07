import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { findUserByEmail } from "./db";
import { safeEqual } from "./crypto";
import type { Session } from "./types";

const COOKIE = "sa_session";

function secret() {
  const s = process.env.APP_SECRET || (process.env.VERCEL ? "" : "dev-only-insecure-secret-change-me");
  if (!s) throw new Error("APP_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function signSession(s: Session): Promise<string> {
  return new SignJWT({ ...s }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d").sign(secret());
}

export async function readSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return { uid: String(payload.uid), email: String(payload.email), name: String(payload.name), role: payload.role === "owner" ? "owner" : "user" };
  } catch {
    return null;
  }
}

export async function setSessionCookie(s: Session) {
  (await cookies()).set(COOKIE, await signSession(s), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 3600,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(COOKIE);
}

/** Owner credentials live in env (cannot be locked out); invited users live in Redis. */
export async function authenticate(email: string, password: string): Promise<Session | null> {
  const ownerEmail = process.env.OWNER_EMAIL ?? "";
  const ownerPass = process.env.OWNER_PASSWORD ?? "";
  if (ownerEmail && ownerPass && email.toLowerCase() === ownerEmail.toLowerCase() && safeEqual(password, ownerPass)) {
    return { uid: "owner", email: ownerEmail, name: process.env.OWNER_NAME || "Owner", role: "owner" };
  }
  const u = await findUserByEmail(email);
  if (u && (await bcrypt.compare(password, u.passwordHash))) {
    return { uid: u.id, email: u.email, name: u.name, role: u.role };
  }
  return null;
}

export async function hashPassword(p: string) {
  return bcrypt.hash(p, 10);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireSession(role?: "owner"): Promise<Session> {
  const s = await readSession();
  if (!s) throw new HttpError(401, "Not signed in");
  if (role === "owner" && s.role !== "owner") throw new HttpError(403, "Owner only");
  return s;
}

/** Cron callers (Vercel cron, GitHub Actions, cron-job.org) authenticate with CRON_SECRET. */
export function isCronRequest(req: Request): boolean {
  const secretVal = process.env.CRON_SECRET;
  if (!secretVal) return false;
  const auth = req.headers.get("authorization") ?? "";
  const url = new URL(req.url);
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("key") ?? "";
  return given.length > 0 && safeEqual(given, secretVal);
}
