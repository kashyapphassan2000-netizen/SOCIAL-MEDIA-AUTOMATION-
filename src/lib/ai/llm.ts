import Anthropic from "@anthropic-ai/sdk";
import { httpJson } from "../http";

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
    const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
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

export const LLM_REGISTRY: Record<string, LLM> = {
  anthropic: new AnthropicLLM(),
  gemini: new GeminiLLM(),
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
