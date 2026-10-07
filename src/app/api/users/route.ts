import { HttpError, hashPassword, requireSession } from "@/lib/auth";
import { body, handle, json } from "@/lib/api";
import { deleteUser, findUserByEmail, listUsers, saveUser } from "@/lib/db";
import { newId } from "@/lib/crypto";
import { logActivity } from "@/lib/sheets";

export const GET = handle(async () => {
  await requireSession("owner");
  return json({ users: (await listUsers()).map(({ passwordHash: _p, ...u }) => u) });
});

export const POST = handle(async (req: Request) => {
  const s = await requireSession("owner");
  const { email, name, password, role } = await body<{ email: string; name: string; password: string; role?: "owner" | "user" }>(req);
  if (!email?.includes("@") || !password || password.length < 8) throw new HttpError(400, "Valid email and an 8+ character password are required");
  if (await findUserByEmail(email)) throw new HttpError(409, "User already exists");
  const u = { id: newId("usr"), email: email.trim().toLowerCase(), name: (name || email).trim(), role: role === "owner" ? "owner" as const : "user" as const, passwordHash: await hashPassword(password), createdAt: new Date().toISOString(), createdBy: s.email };
  await saveUser(u);
  await logActivity(s, "user.add", `${u.email} as ${u.role}`);
  return json({ user: { ...u, passwordHash: undefined } }, 201);
});

export const DELETE = handle(async (req: Request) => {
  const s = await requireSession("owner");
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw new HttpError(400, "id required");
  const u = (await listUsers()).find((x) => x.id === id);
  await deleteUser(id);
  await logActivity(s, "user.remove", u?.email ?? id);
  return json({ ok: true });
});
