import crypto from "node:crypto";
import { getKV } from "./store/kv";
import { decrypt, encrypt, newId } from "./crypto";
import { http } from "./http";
import type { Publisher } from "./publishers";
import type { Platform, PublishResult } from "./types";

/**
 * "Any social network": every finished short is POSTed (JSON) to each webhook outlet you add.
 * Point one at Zapier / Make / n8n / Pipedream / IFTTT / Buffer and post anywhere they reach —
 * networks that have no public API for us (Snapchat, Moj, Josh, ShareChat, Koo, VK...) included.
 * The body carries a public video URL, title, caption and hashtags; X-Shorts-Signature is an
 * HMAC-SHA256 of the body with the outlet's secret so your automation can verify it came from you.
 */
export interface Outlet {
  id: string;
  name: string;
  url: string;
  /** Which built-in caption style to send (e.g. "instagram"); default: generic. */
  captionStyle?: Platform;
  secretEnc: string;
  enabled: boolean;
  addedAt: string;
  last?: { ok: boolean; at: string; status?: number; error?: string };
}

const KEY = "outlets";
/** Keep media this long after a webhook delivery so the receiving automation can download it. */
export const WEBHOOK_MEDIA_HOLD_MIN = 90;

export async function listOutlets(): Promise<Outlet[]> {
  return (await getKV().get<Outlet[]>(KEY)) ?? [];
}

async function save(list: Outlet[]) {
  await getKV().set(KEY, list);
}

export async function addOutlet(input: { name: string; url: string; captionStyle?: Platform }): Promise<{ outlet: Outlet; secret: string }> {
  const url = input.url.trim();
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error("Webhook URL must start with https://");
  const secret = crypto.randomBytes(24).toString("hex");
  const o: Outlet = { id: newId("out"), name: input.name.trim().slice(0, 60) || new URL(url).host, url, captionStyle: input.captionStyle, secretEnc: encrypt(secret), enabled: true, addedAt: new Date().toISOString() };
  await save([...(await listOutlets()), o]);
  return { outlet: o, secret };
}

export async function removeOutlet(id: string) {
  await save((await listOutlets()).filter((o) => o.id !== id));
}

export function outletView(o: Outlet) {
  const { secretEnc, ...rest } = o;
  void secretEnc;
  return rest;
}

export function sign(body: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export async function deliver(o: Outlet, payload: Record<string, unknown>): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify({ ...payload, outlet: o.name });
  try {
    const res = await http(o.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shorts-Signature": sign(body, decrypt(o.secretEnc)), "User-Agent": "ShortsAutopilot/1" },
      body,
      timeoutMs: 30_000,
      retries: 1,
    });
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

async function record(id: string, last: Outlet["last"]) {
  const list = await listOutlets();
  const o = list.find((x) => x.id === id);
  if (o) {
    o.last = last;
    await save(list);
  }
}

/** The "webhook" platform: one delivery per enabled outlet; failed outlets are retried, delivered ones are not repeated. */
export const webhookPublisher: Publisher = {
  platform: "webhook",
  async step(inp, prev): Promise<PublishResult> {
    const outlets = (await listOutlets()).filter((o) => o.enabled);
    if (!outlets.length) throw Object.assign(new Error("No webhook outlets — add one in Connections → Any network"), { permanent: true });
    if (!/^https?:\/\//.test(inp.videoUrl)) throw new Error("Webhooks need a public video URL (deploy with Vercel Blob storage)");
    const done = new Set((prev.pending?.delivered ?? "").split(",").filter(Boolean));
    const sc = inp.script;
    const errors: string[] = [];
    for (const o of outlets) {
      if (done.has(o.id)) continue;
      const r = await deliver(o, {
        event: "short.ready",
        videoUrl: inp.videoUrl,
        thumbnailUrl: inp.thumbnailUrl ?? null,
        title: sc.title,
        description: sc.description,
        caption: (o.captionStyle && sc.captions[o.captionStyle]) || sc.captions.webhook || sc.description,
        captions: sc.captions,
        hashtags: sc.hashtags,
        pinnedComment: sc.pinnedComment ?? null,
        brand: inp.settings.brandName,
        mediaExpiresInMinutes: WEBHOOK_MEDIA_HOLD_MIN,
        privateMode: inp.privateMode,
      });
      await record(o.id, { ok: r.ok, at: new Date().toISOString(), status: r.status, error: r.error });
      if (r.ok) done.add(o.id);
      else errors.push(`${o.name}: ${r.error}`);
    }
    const pending = { delivered: [...done].join(","), deliveredAt: prev.pending?.deliveredAt ?? new Date().toISOString() };
    if (errors.length) throw Object.assign(new Error(errors.join(" | ")), { resetPending: false, pendingOverride: pending });
    return { ...prev, state: "done", postId: `${done.size} outlet(s)`, pending };
  },
};
