import Anthropic from "@anthropic-ai/sdk";
import { HttpFailure, httpJson } from "../http";

export interface LLM {
  name: string;
  available(): boolean;
  /** Returns raw text which must contain one JSON object. */
  complete(system: string, user: string): Promise<string>;
}

class AnthropicLLM implements LLM {
  name = "anthropic";
  available() {
    return !!process.env.ANTHROPIC_API_KEY;
  }
  async complete(system: string, user: string) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
    const msg = await client.beta.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "medium" },
      // Server-side fallback: if a safety classifier declines, Anthropic retries on a suitable model automatically.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (msg.stop_reason === "refusal") throw new Error("Anthropic declined the request (refusal)");
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (!text.trim()) throw new Error(`Anthropic returned no text (stop_reason=${msg.stop_reason})`);
    return text;
  }
}

class GeminiLLM implements LLM {
  name = "gemini";
  available() {
    return !!process.env.GEMINI_API_KEY;
  }
  async complete(system: string, user: string) {
    // Free tier is Flash-only; try the configured model, then newer/older Flash fallbacks.
    const models = [process.env.GEMINI_MODEL, "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
    let last: unknown;
    for (const model of models) {
      try {
        return await this.call(model, system, user);
      } catch (e) {
        last = e;
        if (!(e instanceof HttpFailure && e.status === 404)) throw e;
      }
    }
    throw last;
  }
  private async call(model: string, system: string, user: string) {
    const r = await httpJson<any>(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
      }),
      timeoutMs: 120_000,
    });
    const text = (r.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    if (!text) throw new Error(`Gemini returned no text: ${JSON.stringify(r.promptFeedback ?? r).slice(0, 300)}`);
    return text;
  }
}

class OpenAILLM implements LLM {
  name = "openai";
  available() {
    return !!process.env.OPENAI_API_KEY;
  }
  async complete(system: string, user: string) {
    const r = await httpJson<any>("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
      timeoutMs: 120_000,
    });
    const text = r.choices?.[0]?.message?.content;
    if (!text) throw new Error("OpenAI returned no content");
    return text;
  }
}

/**
 * Any OpenAI-compatible endpoint with a free tier (Groq, Cerebras, OpenRouter, NVIDIA NIM).
 * Free catalogues change constantly, so the model is picked at runtime from the provider's
 * own /models list using a preference order — a retired model never breaks the pipeline.
 */
export class OpenAICompatLLM implements LLM {
  private picked: string | null = null;
  constructor(
    public name: string,
    private base: string,
    private keyEnv: string,
    private modelEnv: string,
    private prefer: (string | RegExp)[],
  ) {}
  available() {
    return !!process.env[this.keyEnv];
  }
  private headers() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${process.env[this.keyEnv]}` };
  }
  async model(): Promise<string> {
    if (process.env[this.modelEnv]) return process.env[this.modelEnv]!;
    if (this.picked) return this.picked;
    const r = await httpJson<{ data: { id: string }[] }>(`${this.base}/models`, { headers: this.headers(), timeoutMs: 20_000, retries: 1 });
    const ids = r.data.map((m) => m.id);
    const ok = (id: string) => !/embed|guard|whisper|tts|vision-only|coder|rerank|safety|reward|audio|image/i.test(id);
    for (const p of this.prefer) {
      const hit = ids.find((id) => ok(id) && (typeof p === "string" ? id === p : p.test(id)));
      if (hit) return (this.picked = hit);
    }
    const any = ids.find(ok);
    if (!any) throw new Error(`${this.name}: no usable chat model in /models`);
    return (this.picked = any);
  }
  async complete(system: string, user: string) {
    const model = await this.model();
    const r = await httpJson<any>(`${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.8, max_tokens: 4000 }),
      timeoutMs: 120_000,
    });
    const text = r.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${this.name} (${model}) returned no content`);
    return text;
  }
}

const BIG = [/gpt-oss-120b/, /deepseek-v[34]/i, /kimi-k[23]/i, /llama-4-maverick/i, /qwen3-235b/i, /llama-3\.3-70b/i, /gpt-oss-20b/, /70b/i];

export const LLM_REGISTRY: Record<string, LLM> = {
  // ---- free tiers (no card needed) ----
  gemini: new GeminiLLM(),
  groq: new OpenAICompatLLM("groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY", "GROQ_MODEL", BIG),
  cerebras: new OpenAICompatLLM("cerebras", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY", "CEREBRAS_MODEL", BIG),
  openrouter: new OpenAICompatLLM("openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", [/:free$/]),
  nvidia: new OpenAICompatLLM("nvidia", "https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY", "NVIDIA_MODEL", BIG),
  // ---- paid ----
  anthropic: new AnthropicLLM(),
  openai: new OpenAILLM(),
};

export function extractJson<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?/gm, "").replace(/```$/gm, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`No JSON object in model output: ${cleaned.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

/** Try each configured provider in order; validate output; first success wins. */
export async function generateJson<T>(
  llms: LLM[],
  system: string,
  user: string,
  validate: (v: unknown) => T,
): Promise<{ data: T; provider: string; errors: string[] }> {
  const errors: string[] = [];
  for (const llm of llms) {
    if (!llm.available()) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await llm.complete(system, attempt ? `${user}\n\nIMPORTANT: respond with ONE valid JSON object only.` : user);
        return { data: validate(extractJson(raw)), provider: llm.name, errors };
      } catch (e) {
        errors.push(`${llm.name}#${attempt + 1}: ${(e as Error).message.slice(0, 300)}`);
      }
    }
  }
  throw new Error(`All LLM providers failed: ${errors.join(" || ") || "none configured (set ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY)"}`);
}
