import { requireSession } from "@/lib/auth";
import { handle, json } from "@/lib/api";

export const GET = handle(async () => json({ user: await requireSession() }));
