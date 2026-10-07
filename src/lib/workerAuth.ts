import { HttpError } from "./auth";
import { safeEqual } from "./crypto";

export function requireWorker(req: Request) {
  const secret = process.env.WORKER_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!secret || !given || !safeEqual(given, secret)) throw new HttpError(401, "bad worker secret");
}
