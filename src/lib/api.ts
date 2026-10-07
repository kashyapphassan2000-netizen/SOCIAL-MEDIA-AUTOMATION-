import { NextResponse } from "next/server";
import { HttpError } from "./auth";
import { ReauthRequired } from "./connections";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/** Uniform error handling for route handlers. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof ReauthRequired) return json({ error: e.message }, 409);
      if ((e as { status?: number }).status === 400) return json({ error: (e as Error).message }, 400);
      console.error(e);
      return json({ error: (e as Error).message ?? "Internal error" }, 500);
    }
  };
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
