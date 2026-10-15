import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryKV, setKV } from "@/lib/store/kv";
import { addOutlet, sign, webhookPublisher } from "@/lib/outlets";
import type { BrandSettings, Script } from "@/lib/types";

let server: http.Server;
let base = "";
const got: { body: string; sig?: string }[] = [];
let failNext = false;
beforeAll(async () => {
  process.env.APP_SECRET ||= "x".repeat(64);
  setKV(new MemoryKV());
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failNext) { failNext = false; res.statusCode = 400; return res.end("nope"); }
      got.push({ body, sig: req.headers["x-shorts-signature"] as string });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const script = { title: "T", description: "D", hashtags: ["AI"], captions: { instagram: "IG caption", webhook: "Generic caption" }, pinnedComment: "Q?" } as unknown as Script;
const inp = (videoUrl = "https://blob.example/v.mp4") => ({ videoUrl, script, settings: { brandName: "AI Wala" } as BrandSettings, privateMode: false, readVideo: async () => Buffer.alloc(0) }) as never;

describe("any-network webhook outlets", () => {
  it("delivers a signed payload with the chosen caption style", async () => {
    const { secret } = await addOutlet({ name: "Zap", url: `${base}/hook`, captionStyle: "instagram" });
    const r = await webhookPublisher.step(inp(), { state: "pending", attempts: 0 });
    expect(r.state).toBe("done");
    const last = got.at(-1)!;
    const body = JSON.parse(last.body);
    expect(body).toMatchObject({ event: "short.ready", videoUrl: "https://blob.example/v.mp4", caption: "IG caption", brand: "AI Wala", outlet: "Zap" });
    expect(last.sig).toBe(sign(last.body, secret));
    expect(r.pending?.deliveredAt).toBeTruthy();
  });

  it("retries only the outlets that failed", async () => {
    await addOutlet({ name: "Make", url: `${base}/hook2` });
    setKV(new MemoryKV());
    await addOutlet({ name: "A", url: `${base}/a` });
    await addOutlet({ name: "B", url: `${base}/b` });
    const before = got.length;
    failNext = true; // first delivery (A) fails
    type E = Error & { pendingOverride?: Record<string, string> };
    const err = await webhookPublisher.step(inp(), { state: "pending", attempts: 0 }).then(() => null, (e: E) => e);
    expect(err?.message).toContain("A:");
    expect(got.length).toBe(before + 1); // B delivered
    const r = await webhookPublisher.step(inp(), { state: "pending", attempts: 1, pending: err!.pendingOverride });
    expect(r.state).toBe("done");
    expect(got.length).toBe(before + 2); // only A re-sent
    expect(JSON.parse(got.at(-1)!.body).outlet).toBe("A");
  });

  it("refuses non-public video URLs", async () => {
    await expect(webhookPublisher.step(inp("file:///tmp/v.mp4"), { state: "pending", attempts: 0 })).rejects.toThrow(/public video URL/);
  });
});
