import { HttpError } from "./auth";
import { safeEqual } from "./crypto";
import { isGithubActions } from "./ghoidc";

/** Workers authenticate with WORKER_SECRET, or (GitHub Actions in this repo) with a GitHub OIDC token. */
export async function requireWorker(req: Request) {
  const secret = process.env.WORKER_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (secret && given && safeEqual(given, secret)) return;
  if (await isGithubActions(req)) return;
  throw new HttpError(401, "bad worker secret");
}
