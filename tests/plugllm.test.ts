import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryKV, setKV } from "@/lib/store/kv";
import { addProvider, detect, listCustom, loadCustomLLMs, publicView, removeProvider } from "@/lib/ai/custom";
import { LLM_REGISTRY } from "@/lib/ai/llm";

// A stand-in for any OpenAI-compatible server (Ollama, LM Studio, a hosted API...).
let server: http.Server;
let base = "";
const seen: { auth?: string; model?: string }[] = [];
beforeAll(async () => {
  process.env.APP_SECRET ||= "x".repeat(64);
  setKV(new MemoryKV());
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "text-embedding-3" }, { id: "llama-3.3-70b-instruct" }] }));
      const b = JSON.parse(body || "{}");
      seen.push({ auth: req.headers.authorization, model: b.model });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok": true, "word": "neat"}' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

describe("plug-and-play AI brain", () => {
  it("detects providers from the key prefix", async () => {
    expect((await detect("gsk_abc")).label).toBe("Groq");
    expect((await detect("sk-ant-abc")).kind).toBe("anthropic");
    expect((await detect("AIzaXYZ")).baseUrl).toContain("generativelanguage");
  });

  it("tests, stores encrypted, picks a chat model and registers it", async () => {
    const c = await addProvider({ key: "local-key-123", baseUrl: base });
    expect(c.model).toBe("llama-3.3-70b-instruct"); // embedding model skipped
    expect(c.keyEnc).not.toContain("local-key-123");
    expect(publicView(c)).not.toHaveProperty("keyEnc");
    const names = await loadCustomLLMs();
    expect(names).toContain(`custom:${c.id}`);
    const out = await LLM_REGISTRY[`custom:${c.id}`].complete("sys", "user");
    expect(out).toContain('"ok"');
    expect(seen.at(-1)).toEqual({ auth: "Bearer local-key-123", model: "llama-3.3-70b-instruct" });
    await removeProvider(c.id);
    expect(await listCustom()).toHaveLength(0);
    expect(LLM_REGISTRY[`custom:${c.id}`]).toBeUndefined();
  });

  it("rejects an endpoint that does not answer with JSON", async () => {
    await expect(addProvider({ key: "k", baseUrl: "http://127.0.0.1:9/v1", model: "m" })).rejects.toThrow();
  });
});
