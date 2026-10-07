import fs from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";

/**
 * Minimal key-value contract the whole app runs on.
 * Production: Upstash Redis (Vercel Marketplace). Local / tests: in-memory, optionally persisted to .data/kv.json.
 */
export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ttlSec?: number }): Promise<void>;
  del(key: string): Promise<void>;
  /** SET key NX EX ttl — returns true when the lock was acquired. */
  setNx(key: string, value: string, ttlSec: number): Promise<boolean>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<boolean>;
  rpush(key: string, value: unknown): Promise<void>;
  lrange<T>(key: string, start: number, stop: number): Promise<T[]>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  incr(key: string, ttlSec?: number): Promise<number>;
}

class RedisKV implements KV {
  constructor(private r: Redis) {}
  async get<T>(key: string) {
    return (await this.r.get<T>(key)) ?? null;
  }
  async set(key: string, value: unknown, opts?: { ttlSec?: number }) {
    if (opts?.ttlSec) await this.r.set(key, value, { ex: opts.ttlSec });
    else await this.r.set(key, value);
  }
  async del(key: string) {
    await this.r.del(key);
  }
  async setNx(key: string, value: string, ttlSec: number) {
    return (await this.r.set(key, value, { nx: true, ex: ttlSec })) === "OK";
  }
  async sadd(key: string, member: string) {
    await this.r.sadd(key, member);
  }
  async srem(key: string, member: string) {
    await this.r.srem(key, member);
  }
  async smembers(key: string) {
    return (await this.r.smembers(key)) as string[];
  }
  async sismember(key: string, member: string) {
    return (await this.r.sismember(key, member)) === 1;
  }
  async rpush(key: string, value: unknown) {
    await this.r.rpush(key, value);
  }
  async lrange<T>(key: string, start: number, stop: number) {
    return (await this.r.lrange<T>(key, start, stop)) as T[];
  }
  async ltrim(key: string, start: number, stop: number) {
    await this.r.ltrim(key, start, stop);
  }
  async incr(key: string, ttlSec?: number) {
    const n = await this.r.incr(key);
    if (ttlSec && n === 1) await this.r.expire(key, ttlSec);
    return n;
  }
}

type Entry = { v: unknown; exp?: number };

export class MemoryKV implements KV {
  private m = new Map<string, Entry>();
  constructor(private file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Entry>;
        for (const [k, e] of Object.entries(raw)) this.m.set(k, e);
      } catch {
        /* corrupt local cache — start fresh */
      }
    }
  }
  private persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.m)));
  }
  private live(key: string): Entry | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp && e.exp < Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }
  private clone<T>(v: T): T {
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  }
  async get<T>(key: string) {
    const e = this.live(key);
    return e ? this.clone(e.v as T) : null;
  }
  async set(key: string, value: unknown, opts?: { ttlSec?: number }) {
    this.m.set(key, { v: this.clone(value), exp: opts?.ttlSec ? Date.now() + opts.ttlSec * 1000 : undefined });
    this.persist();
  }
  async del(key: string) {
    this.m.delete(key);
    this.persist();
  }
  async setNx(key: string, value: string, ttlSec: number) {
    if (this.live(key)) return false;
    await this.set(key, value, { ttlSec });
    return true;
  }
  private setOf(key: string): string[] {
    return ((this.live(key)?.v as string[]) ?? []).slice();
  }
  async sadd(key: string, member: string) {
    const s = new Set(this.setOf(key));
    s.add(member);
    this.m.set(key, { v: [...s], exp: this.live(key)?.exp });
    this.persist();
  }
  async srem(key: string, member: string) {
    this.m.set(key, { v: this.setOf(key).filter((x) => x !== member) });
    this.persist();
  }
  async smembers(key: string) {
    return this.setOf(key);
  }
  async sismember(key: string, member: string) {
    return this.setOf(key).includes(member);
  }
  async rpush(key: string, value: unknown) {
    const l = ((this.live(key)?.v as unknown[]) ?? []).slice();
    l.push(this.clone(value));
    this.m.set(key, { v: l });
    this.persist();
  }
  async lrange<T>(key: string, start: number, stop: number) {
    const l = (this.live(key)?.v as T[]) ?? [];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    return this.clone(l.slice(start, end));
  }
  async ltrim(key: string, start: number, stop: number) {
    const l = (this.live(key)?.v as unknown[]) ?? [];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    this.m.set(key, { v: l.slice(start, end) });
    this.persist();
  }
  async incr(key: string, ttlSec?: number) {
    const e = this.live(key);
    const n = Number(e?.v ?? 0) + 1;
    this.m.set(key, { v: n, exp: e?.exp ?? (ttlSec ? Date.now() + ttlSec * 1000 : undefined) });
    this.persist();
    return n;
  }
}

let singleton: KV | null = null;

export function getKV(): KV {
  if (singleton) return singleton;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    singleton = new RedisKV(new Redis({ url, token }));
  } else {
    if (process.env.VERCEL) {
      // On Vercel without Redis every invocation would start from zero — refuse loudly instead of silently losing state.
      throw new Error("No Redis configured. Add Upstash Redis from the Vercel Marketplace (KV_REST_API_URL / KV_REST_API_TOKEN).");
    }
    singleton = new MemoryKV(path.join(process.cwd(), ".data", "kv.json"));
  }
  return singleton;
}

export function setKV(kv: KV) {
  singleton = kv;
}
