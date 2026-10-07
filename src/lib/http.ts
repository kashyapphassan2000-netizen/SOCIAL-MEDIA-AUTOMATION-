/** fetch with timeout + retries on network errors / 429 / 5xx. Throws HttpFailure with body text for diagnostics. */
export class HttpFailure extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string,
  ) {
    super(`HTTP ${status} from ${redact(url)}: ${body.slice(0, 600)}`);
  }
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export function redact(url: string) {
  return url.replace(/(access_token|key|token)=[^&]+/gi, "$1=***");
}

export interface FetchOpts extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function http(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 60_000, retries = 2, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      const fail = new HttpFailure(res.status, body, url);
      if (!fail.retryable || attempt === retries) throw fail;
      lastErr = fail;
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 20) * 1000 : 1000 * 2 ** attempt);
    } catch (e) {
      if (e instanceof HttpFailure && !e.retryable) throw e;
      lastErr = e instanceof HttpFailure ? e : new HttpFailure(0, String((e as Error)?.message ?? e), url);
      if (attempt === retries) throw lastErr;
      await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function httpJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await http(url, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export async function download(url: string, timeoutMs = 120_000): Promise<Buffer> {
  const res = await http(url, { timeoutMs, retries: 2 });
  return Buffer.from(await res.arrayBuffer());
}

export function form(data: Record<string, string | number | boolean | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) p.set(k, String(v));
  return p;
}
