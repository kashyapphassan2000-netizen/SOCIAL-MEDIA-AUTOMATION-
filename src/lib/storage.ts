import fs from "node:fs";
import path from "node:path";
import { put, del } from "@vercel/blob";
import { download } from "./http";

/**
 * Public file storage. Generated media must be reachable by public URL because
 * fal.ai, Instagram, Threads and Facebook pull videos by URL.
 */
export interface Storage {
  put(name: string, data: Buffer, contentType: string): Promise<string>;
  read(url: string): Promise<Buffer>;
  del(urls: string[]): Promise<void>;
  /** true when other services on the internet can fetch our URLs. */
  publicUrls: boolean;
}

class VercelBlobStorage implements Storage {
  publicUrls = true;
  async put(name: string, data: Buffer, contentType: string) {
    const r = await put(name, data, { access: "public", contentType, addRandomSuffix: true });
    return r.url;
  }
  async read(url: string) {
    return download(url);
  }
  async del(urls: string[]) {
    const own = urls.filter((u) => u.includes(".blob.vercel-storage.com"));
    if (own.length) await del(own);
  }
}

export class LocalStorage implements Storage {
  publicUrls = false;
  constructor(private dir = path.join(process.cwd(), ".data", "blobs")) {}
  async put(name: string, data: Buffer) {
    const safe = `${Date.now().toString(36)}-${name.replace(/[^\w.-]/g, "_")}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const p = path.join(this.dir, safe);
    fs.writeFileSync(p, data);
    return `file://${p}`;
  }
  async read(url: string) {
    if (url.startsWith("file://")) return fs.readFileSync(url.slice(7));
    return download(url);
  }
  async del(urls: string[]) {
    for (const u of urls) if (u.startsWith("file://")) fs.rmSync(u.slice(7), { force: true });
  }
}

let singleton: Storage | null = null;
export function getStorage(): Storage {
  if (singleton) return singleton;
  singleton = process.env.BLOB_READ_WRITE_TOKEN ? new VercelBlobStorage() : new LocalStorage();
  return singleton;
}
export function setStorage(s: Storage) {
  singleton = s;
}
