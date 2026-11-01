import type { LLMProvider, LLMRequest, LLMResponse } from "@book/schema";
import { computeCost, priceFromEnv } from "./pricing.ts";
import { LLMError } from "./anthropic.ts";

type Env = Record<string, string | undefined>;
type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface GrokProviderOptions {
  apiKey?: string;
  env?: Env;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  maxRetries?: number;
  backoffBaseMs?: number;
}

const RETRYABLE = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);
const STORYTELLER_DOWN = "The storyteller is unavailable right now. Try again in a moment.";
const DEFAULT_GROK: Record<LLMRequest["tier"], string> = {
  strong: "grok-4.7",
  cheap: "grok-4.3",
};
const REASONING = new Set(["low", "medium", "high", "xhigh"]);

interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: unknown; refusal?: string | null } }[];
  usage?: ApiUsage;
}

function errorDetail(raw: string, secret: string): string {
  let detail = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; type?: string } | string };
    const err = parsed.error;
    if (typeof err === "string" && err.trim() !== "") detail = err;
    else if (err && typeof err === "object" && err.message) detail = `${err.type ?? "error"}: ${err.message}`;
  } catch {
    /* not JSON */
  }
  return secret ? detail.split(secret).join("[redacted]") : detail;
}

function modelMissing(status: number, raw: string): boolean {
  if (status === 404) return true;
  return status === 400 && /model/i.test(raw) && /not found|does not exist|unknown model|invalid/i.test(raw);
}

/** A Claude id left in the environment must not be sent to xAI. */
export function grokModel(tier: LLMRequest["tier"], env: Env): string {
  const requested = env[`BOOK_MODEL_${tier.toUpperCase()}`]?.trim() ?? "";
  if (requested.toLowerCase().startsWith("grok")) return requested;
  return DEFAULT_GROK[tier];
}

function reasoningEffort(env: Env): string {
  const requested = env.BOOK_GROK_REASONING?.trim().toLowerCase() ?? "";
  return REASONING.has(requested) ? requested : "low";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

/**
 * xAI's OpenAI-compatible chat completions. Reasoning cannot be turned off; `low` is the
 * default so hidden reasoning tokens do not eat the reply budget or the account cap.
 */
export class GrokProvider implements LLMProvider {
  readonly name = "grok";
  private readonly apiKey: string;
  private readonly env: Env;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;

  constructor(opts: GrokProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    const key = opts.apiKey ?? this.env.XAI_API_KEY;
    if (!key || key.trim() === "") {
      throw new LLMError("XAI_API_KEY is not set. Export it in your shell to use the grok provider.");
    }
    this.apiKey = key.trim();
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? "https://api.x.ai/v1/chat/completions";
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (req.messages.length === 0) throw new LLMError("LLM request has no messages");
    let model = grokModel(req.tier, this.env);
    let modelRetried = false;
    const messages: { role: string; content: string }[] = [];
    if (req.system.length > 0) {
      messages.push({ role: "system", content: req.system.map((block) => block.text).join("\n\n") });
    }
    for (const message of req.messages) messages.push({ role: message.role, content: message.content });

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.max_tokens,
      messages,
      reasoning_effort: reasoningEffort(this.env),
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.json === true) body.response_format = { type: "json_object" };
    let payload = JSON.stringify(body);

    const started = performance.now();
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await this.fetchFn(this.baseUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: payload,
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffBaseMs * 2 ** attempt++);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new LLMError(`Network error calling Grok: ${msg.split(this.apiKey).join("[redacted]")}`);
      }

      const raw = await res.text();
      if (res.ok) return this.parse(raw, model, req, started);

      if (RETRYABLE(res.status) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffBaseMs * 2 ** attempt;
        attempt++;
        await this.sleep(wait);
        continue;
      }
      if (res.status === 400 && body.reasoning_effort !== undefined && /reasoning/i.test(raw)) {
        delete body.reasoning_effort;
        payload = JSON.stringify(body);
        continue;
      }
      if (res.status === 400 && body.response_format !== undefined && /response_format|json/i.test(raw)) {
        delete body.response_format;
        payload = JSON.stringify(body);
        continue;
      }
      if (modelMissing(res.status, raw)) {
        const fallback = DEFAULT_GROK[req.tier];
        if (!modelRetried && fallback !== model) {
          modelRetried = true;
          model = fallback;
          body.model = model;
          payload = JSON.stringify(body);
          continue;
        }
        throw new LLMError(STORYTELLER_DOWN, res.status);
      }
      if (res.status === 401 || res.status === 403) {
        throw new LLMError(`Grok rejected the API key (HTTP ${res.status}). Check XAI_API_KEY.`, res.status);
      }
      throw new LLMError(`Grok API error (HTTP ${res.status}): ${errorDetail(raw, this.apiKey)}`, res.status);
    }
  }

  private parse(raw: string, model: string, req: LLMRequest, started: number): LLMResponse {
    let json: ChatCompletion;
    try {
      json = JSON.parse(raw) as ChatCompletion;
    } catch {
      throw new LLMError("Grok returned a non-JSON response body");
    }
    const choice = json.choices?.[0]?.message;
    const text = messageText(choice?.content);
    if (text.trim() === "" && choice?.refusal) {
      throw new LLMError("Grok refused the turn.");
    }
    const usage = json.usage ?? {};
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const input = usage.prompt_tokens ?? 0;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
    const output = (usage.completion_tokens ?? 0) + reasoning;
    return {
      text,
      usage: {
        model: json.model ?? model,
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
        cost_usd: computeCost(priceFromEnv(req.tier, this.env, json.model ?? model), input, output, cached),
        latency_ms: Math.round(performance.now() - started),
        purpose: req.purpose,
      },
    };
  }
}
