import { authenticate, HttpError, setSessionCookie } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { getKV } from "@/lib/store/kv";

export const POST = handle(async (req: Request) => {
  const { email, password } = await body<{ email: string; password: string }>(req);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  // Brute-force guard: 10 failed attempts per IP per 15 minutes.
  const kv = getKV();
  const failKey = `loginfail:${ip}`;
  if (Number((await kv.get<number>(failKey)) ?? 0) >= 10) throw new HttpError(429, "Too many attempts — wait 15 minutes");
  const s = await authenticate(String(email ?? "").trim(), String(password ?? ""));
  if (!s) {
    await kv.incr(failKey, 900);
    throw new HttpError(401, "Wrong email or password");
  }
  await setSessionCookie(s);
  return json({ ok: true, user: s });
});
