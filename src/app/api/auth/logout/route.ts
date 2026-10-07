import { clearSessionCookie } from "@/lib/auth";
import { handle, json } from "@/lib/api";

export const POST = handle(async () => {
  await clearSessionCookie();
  return json({ ok: true });
});
