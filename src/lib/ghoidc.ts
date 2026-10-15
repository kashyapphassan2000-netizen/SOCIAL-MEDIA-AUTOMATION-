import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * GitHub Actions OIDC: workflows in THIS repo prove who they are with a short-lived token signed by GitHub,
 * so the heartbeat and the free worker need no shared secrets in GitHub (nothing to copy into repo settings).
 * The repo comes from GITHUB_REPO, or from Vercel's automatic VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG.
 */
export const OIDC_AUDIENCE = "shorts-autopilot";
const ISSUER = "https://token.actions.githubusercontent.com";
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export function trustedRepo(): string | null {
  const r = process.env.GITHUB_REPO || (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}` : "");
  return r && r !== "owner/repo" ? r.toLowerCase() : null;
}

export async function isGithubActions(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const repo = trustedRepo();
  if (!repo || token.split(".").length !== 3) return false;
  try {
    jwks ??= createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: OIDC_AUDIENCE });
    return String(payload.repository ?? "").toLowerCase() === repo;
  } catch {
    return false;
  }
}
