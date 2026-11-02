/**
 * Model routing. With ANTHROPIC_API_KEY set, both tiers use the owner's key. Without it, both use Workers AI, the free
 * model on the owner's Cloudflare account. With neither, every call throws and the callers fall back to word rules. In
 * demo mode a canned model answers (core/demo.ts). Every real call is logged to llm_usage. Tests swap the whole thing with
 * setLlmFactory().
 */
import type { Db, Env, LLM, LlmCompleteOptions, LlmJsonOptions, LlmTier, Settings } from "./types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export type LlmFactory = (env: Env, db: Db, settings: Settings) => LLM;
let factoryOverride: LlmFactory | null = null;

/** Tests and the demo: install a fake LLM for every ctx created afterwards. Pass null to restore. */
export function setLlmFactory(f: LlmFactory | null): void {
  factoryOverride = f;
}

export function makeLlm(env: Env, db: Db, settings: Settings): LLM {
  if (factoryOverride) return factoryOverride(env, db, settings);
  return new RealLlm(env, db, settings);
}

interface Resolved {
  backend: "anthropic" | "workers-ai" | "none";
  model: string;
}

class RealLlm implements LLM {
  constructor(
    private env: Env,
    private db: Db,
    private settings: Settings,
  ) {}

  private async resolve(tier: LlmTier): Promise<Resolved> {
    const s = this.settings;
    if (this.env.ANTHROPIC_API_KEY) return { backend: "anthropic", model: await s.get(`llm.model.anthropic.${tier}`, tier === "smart" ? "claude-sonnet-5-5" : "claude-haiku-5-5") };
    if (this.env.AI) return { backend: "workers-ai", model: await s.get(`llm.model.workers.${tier}`, tier === "smart" ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast" : "@cf/meta/llama-3.1-8b-instruct-fast") };
    return { backend: "none", model: "none" };
  }

  describe(): Record<LlmTier, string> {
    const which = this.env.ANTHROPIC_API_KEY ? "your Anthropic API key" : this.env.AI ? "Workers AI (free)" : "no model: word rules only";
    return { cheap: which, smart: which };
  }

  private async logUsage(row: { tier: string; model: string; purpose?: string; input?: number; output?: number; ms: number; ok: boolean; error?: string }) {
    try {
      await this.db.insert("llm_usage", {
        tier: row.tier,
        model: row.model,
        purpose: row.purpose ?? null,
        input_tokens: row.input ?? null,
        output_tokens: row.output ?? null,
        ms: Math.round(row.ms),
        ok: row.ok ? 1 : 0,
        error: row.error ? row.error.slice(0, 500) : null,
      });
    } catch (e) {
      console.warn("llm_usage insert failed", e);
    }
  }

  async complete(opts: LlmCompleteOptions): Promise<string> {
    const r = await this.resolve(opts.tier);
    if (r.backend === "none") throw new Error("no model configured");
    const t0 = Date.now();
    try {
      const out = r.backend === "anthropic" ? await this.anthropic(r.model, opts) : await this.workersText(r.model, opts);
      await this.logUsage({ tier: opts.tier, model: r.model, purpose: opts.purpose, input: out.input, output: out.output, ms: Date.now() - t0, ok: true });
      return out.text;
    } catch (e) {
      await this.logUsage({ tier: opts.tier, model: r.model, purpose: opts.purpose, ms: Date.now() - t0, ok: false, error: String(e) });
      throw e;
    }
  }

  async json<T>(opts: LlmJsonOptions<T>): Promise<T> {
    if (!this.env.ANTHROPIC_API_KEY && !this.env.AI) throw new Error("no model configured");
    const retries = opts.retries ?? 2;
    const shape = opts.shape ? `\nRespond with JSON of exactly this shape:\n${JSON.stringify(opts.shape, null, 1)}` : "";
    const system = `${opts.system ?? ""}\nYou output only a single JSON value. No prose, no markdown fences.${shape}`.trim();
    let lastErr: unknown;
    let prompt = opts.prompt;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const text = await this.complete({ ...opts, system, prompt });
        const parsed = extractJson(text);
        const v = opts.validate(parsed);
        if (v == null) throw new Error("validator rejected value");
        return v;
      } catch (e) {
        lastErr = e;
        prompt = `${opts.prompt}\n\n(Your previous answer was invalid: ${String(e).slice(0, 200)}. Output only valid JSON.)`;
      }
    }
    throw new Error(`llm.json failed after ${retries + 1} attempts: ${String(lastErr)}`);
  }

  private async workersText(model: string, opts: LlmCompleteOptions): Promise<{ text: string; input?: number; output?: number }> {
    const messages = [] as Array<{ role: string; content: string }>;
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: opts.prompt });
    const res = (await (this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(model, {
      messages,
      max_tokens: opts.maxTokens ?? 1024,
    })) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { text: asText(res.response), input: res.usage?.prompt_tokens, output: res.usage?.completion_tokens };
  }

  private async anthropic(model: string, opts: LlmCompleteOptions): Promise<{ text: string; input?: number; output?: number }> {
    const body: Record<string, unknown> = { model, max_tokens: opts.maxTokens ?? 2000, messages: [{ role: "user", content: opts.prompt }] };
    if (opts.system) body.system = opts.system;
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY!, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = (await res.json()) as { stop_reason?: string; content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    if (data.stop_reason === "refusal") throw new Error("Anthropic refused");
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { text, input: data.usage?.input_tokens, output: data.usage?.output_tokens };
  }
}

/** Pull the first JSON value out of model output that may include fences or prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = Math.min(...["{", "["].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0));
  if (Number.isFinite(start)) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end > start) return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("no JSON found in model output");
}

/** Workers AI sometimes returns `response` already parsed (an object) when the model emits JSON. */
function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  return JSON.stringify(v);
}
