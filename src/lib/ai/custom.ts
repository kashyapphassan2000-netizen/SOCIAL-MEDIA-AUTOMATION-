import { getKV } from "../store/kv";
import { decrypt, encrypt, newId } from "../crypto";
import { httpJson } from "../http";
import { AnthropicLLM, BIG, LLM_REGISTRY, OpenAICompatLLM, extractJson, type LLM } from "./llm";

/**
 * Plug-and-play script AI: paste ANY key (and a base URL for anything unusual) in Settings.
 * The provider is detected from the key, a model is picked from its live /models list, a real JSON
 * round-trip is tested, and on success it becomes the first choice — nothing else needs changing.
 * Works with any OpenAI-compatible API (OpenAI, Groq, DeepSeek, Mistral, xAI, Together, Fireworks,
 * OpenRouter, NVIDIA, Gemini, Hugging Face, Ollama / LM Studio on your PC, ...) plus native Anthropic.
 */
export interface CustomLLM {
  id: string;
  label: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  keyEnc: string;
  model: string;
  addedAt: string;
  lastTest?: { ok: boolean; at: string; ms?: number; error?: string };
}

const KEY = "llm:custom";
/** Preference when a provider lists many models: strong open models first, then each vendor's flagship chat line. */
const PREFER: (string | RegExp)[] = [...BIG, /^gpt-5(\.\d)?-mini$/, /^gpt-5(\.\d)?$/, /^gpt-4\.1/, /deepseek-chat/, /mistral-(large|medium)-latest/, /^grok-4/, /gemini-[\d.]+-flash$/, /gemini-[\d.]+-pro$/, /llama/i, /qwen/i, /mixtral/i];

/** Key prefix → provider. Keys without a telling prefix are probed against the common hosts. */
const KNOWN: { prefix: RegExp; label: string; kind: CustomLLM["kind"]; baseUrl: string }[] = [
  { prefix: /^sk-ant-/, label: "Anthropic Claude", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { prefix: /^sk-or-/, label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { prefix: /^gsk_/, label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { prefix: /^csk-/, label: "Cerebras", kind: "openai", baseUrl: "https://api.cerebras.ai/v1" },
  { prefix: /^nvapi-/, label: "NVIDIA NIM", kind: "openai", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { prefix: /^(AIza|AQ\.)/, label: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { prefix: /^xai-/, label: "xAI Grok", kind: "openai", baseUrl: "https://api.x.ai/v1" },
  { prefix: /^pplx-/, label: "Perplexity", kind: "openai", baseUrl: "https://api.perplexity.ai" },
  { prefix: /^hf_/, label: "Hugging Face", kind: "openai", baseUrl: "https://router.huggingface.co/v1" },
  { prefix: /^fw_/, label: "Fireworks", kind: "openai", baseUrl: "https://api.fireworks.ai/inference/v1" },
];
const PROBE: { label: string; baseUrl: string }[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { label: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { label: "Together AI", baseUrl: "https://api.together.xyz/v1" },
  { label: "Moonshot Kimi", baseUrl: "https://api.moonshot.ai/v1" },
];

export async function listCustom(): Promise<CustomLLM[]> {
  return (await getKV().get<CustomLLM[]>(KEY)) ?? [];
}

async function saveCustom(list: CustomLLM[]) {
  await getKV().set(KEY, list);
}

function instance(c: CustomLLM, key = decrypt(c.keyEnc)): LLM {
  return c.kind === "anthropic"
    ? new AnthropicLLM(`custom:${c.id}`, { key, model: c.model || undefined })
    : new OpenAICompatLLM(`custom:${c.id}`, c.baseUrl.replace(/\/+$/, ""), "", "", PREFER, undefined, { key: key || undefined, model: c.model });
}

/** Make saved providers resolvable by name ("custom:<id>") in the shared registry. Call before using LLMs. */
export async function loadCustomLLMs(): Promise<string[]> {
  for (const k of Object.keys(LLM_REGISTRY)) if (k.startsWith("custom:")) delete LLM_REGISTRY[k];
  const list = await listCustom().catch(() => [] as CustomLLM[]);
  for (const c of list) {
    try {
      LLM_REGISTRY[`custom:${c.id}`] = instance(c);
    } catch {
      /* key no longer decrypts (APP_SECRET changed) — skip */
    }
  }
  return list.map((c) => `custom:${c.id}`);
}

async function modelsOf(baseUrl: string, key: string): Promise<string[]> {
  const r = await httpJson<{ data?: { id: string }[]; models?: { name?: string; id?: string }[] }>(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    timeoutMs: 20_000,
    retries: 0,
  });
  return (r.data ?? []).map((m) => m.id).concat((r.models ?? []).map((m) => (m.id || m.name || "").replace(/^models\//, ""))).filter(Boolean);
}

export async function detect(key: string, baseUrl?: string): Promise<{ label: string; kind: CustomLLM["kind"]; baseUrl: string }> {
  if (baseUrl) return { label: new URL(baseUrl).host, kind: /anthropic\.com/.test(baseUrl) ? "anthropic" : "openai", baseUrl };
  const k = KNOWN.find((p) => p.prefix.test(key));
  if (k) return k;
  for (const p of PROBE) {
    try {
      if ((await modelsOf(p.baseUrl, key)).length) return { ...p, kind: "openai" };
    } catch {
      /* not this one */
    }
  }
  throw new Error("Could not tell which service this key belongs to — add its base URL (the part before /chat/completions)");
}

const TEST_SYSTEM = 'You are a JSON API. Reply with exactly {"ok": true, "word": "<one word describing AI>"} and nothing else.';

/** Detect → pick model → real JSON round-trip. Throws with a readable reason. */
export async function testProvider(input: { key: string; baseUrl?: string; model?: string }) {
  const key = input.key.trim();
  const d = await detect(key, input.baseUrl?.trim() || undefined);
  let model = input.model?.trim() || "";
  if (!model && d.kind === "openai") {
    const probe = new OpenAICompatLLM("probe", d.baseUrl.replace(/\/+$/, ""), "", "", PREFER, undefined, { key: key || undefined });
    model = await probe.model();
  }
  if (!model && d.kind === "anthropic") model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const tmp: CustomLLM = { id: "test", label: d.label, kind: d.kind, baseUrl: d.baseUrl, keyEnc: "", model, addedAt: "" };
  const llm = instance(tmp, key);
  const t0 = Date.now();
  const out = extractJson<{ ok?: boolean }>(await llm.complete(TEST_SYSTEM, "Test."));
  if (out.ok !== true) throw new Error("model answered but not with the expected JSON");
  return { ...d, model, ms: Date.now() - t0 };
}

/** Test, store (key encrypted), and return the new provider name to put first in Settings → llmProviders. */
export async function addProvider(input: { key: string; baseUrl?: string; model?: string; label?: string }): Promise<CustomLLM> {
  const t = await testProvider(input);
  const c: CustomLLM = {
    id: newId("llm"),
    label: input.label?.trim() || t.label,
    kind: t.kind,
    baseUrl: t.baseUrl,
    keyEnc: encrypt(input.key.trim()),
    model: t.model,
    addedAt: new Date().toISOString(),
    lastTest: { ok: true, at: new Date().toISOString(), ms: t.ms },
  };
  const list = (await listCustom()).filter((x) => !(x.baseUrl === c.baseUrl && decryptSafe(x.keyEnc) === input.key.trim()));
  await saveCustom([c, ...list]);
  await loadCustomLLMs();
  return c;
}

export async function removeProvider(id: string) {
  await saveCustom((await listCustom()).filter((c) => c.id !== id));
  await loadCustomLLMs();
}

function decryptSafe(s: string) {
  try {
    return decrypt(s);
  } catch {
    return "";
  }
}

/** What the UI may see (never the key). */
export function publicView(c: CustomLLM) {
  const { keyEnc, ...rest } = c;
  const k = decryptSafe(keyEnc);
  return { ...rest, name: `custom:${c.id}`, keyHint: k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "(none)" };
}
