import type { LLMProvider, LLMRequest, LLMResponse, LLMTier } from "@book/schema";
import { LLMError } from "./anthropic.ts";
import { computeCost, priceFromEnv } from "./pricing.ts";

type Env = Record<string, string | undefined>;
type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface XaiProviderOptions {
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
const DEFAULT_GROK = "grok-4.7";
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface OutputItem {
  type?: string;
  content?: { type?: string; text?: string }[];
}

function modelMissing(status: number, raw: string): boolean {
  if (status === 404) return true;
  return status === 400 && /model/i.test(raw) && /not found|does not exist|unknown model/i.test(raw);
}

function errorDetail(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { type?: string; message?: string } };
    if (j.error?.message) return `${j.error.type ?? "error"}: ${j.error.message}`;
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 300);
}

/** A Grok id from the env, or the current default. Claude ids are not sent to this API. */
export function resolveXaiModel(tier: LLMTier, env: Env): string {
  const v = env[`BOOK_MODEL_${tier.toUpperCase()}`]?.trim() ?? "";
  return v.startsWith("grok") ? v : DEFAULT_GROK;
}

function reasoningEffort(env: Env): string {
  const v = env.BOOK_XAI_REASONING?.trim().toLowerCase() ?? "";
  return EFFORTS.has(v) ? v : "low";
}

/**
 * Grok on the Responses API. `store` stays off: the engine keeps the transcript.
 * Reasoning cannot be turned off; effort stays low so a turn is not billed as a long think.
 * `max_output_tokens` caps the visible reply. Reasoning tokens are outside that cap and still billed.
 */
export class XaiProvider implements LLMProvider {
  readonly name = "xai";
  private readonly apiKey: string;
  private readonly env: Env;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;

  constructor(opts: XaiProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    const key = opts.apiKey ?? this.env.XAI_API_KEY;
    if (!key || key.trim() === "") {
      throw new LLMError("XAI_API_KEY is not set. Export it in your shell to use the xai provider.");
    }
    this.apiKey = key.trim();
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? "https://api.x.ai/v1/responses";
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (req.messages.length === 0) throw new LLMError("LLM request has no messages");
    let model = resolveXaiModel(req.tier, this.env);
    let modelRetried = false;
    const input: { role: string; content: string }[] = [];
    if (req.system.length > 0) {
      input.push({ role: "system", content: req.system.map((b) => b.text).join("\n\n") });
    }
    for (const message of req.messages) input.push({ role: message.role, content: message.content });
    const body: Record<string, unknown> = {
      model,
      store: false,
      input,
      max_output_tokens: req.max_tokens,
      reasoning: { effort: reasoningEffort(this.env) },
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.json === true) body.text = { format: { type: "json_object" } };
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
        throw new LLMError(`Network error calling xAI: ${msg}`);
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
      if (res.status === 400 && body.text !== undefined && /format|json_object|response_format/i.test(raw)) {
        delete body.text;
        payload = JSON.stringify(body);
        continue;
      }
      if (res.status === 400 && body.reasoning !== undefined && /reasoning/i.test(raw)) {
        delete body.reasoning;
        payload = JSON.stringify(body);
        continue;
      }
      if (modelMissing(res.status, raw)) {
        if (!modelRetried && model !== DEFAULT_GROK) {
          modelRetried = true;
          model = DEFAULT_GROK;
          body.model = model;
          payload = JSON.stringify(body);
          continue;
        }
        throw new LLMError(STORYTELLER_DOWN, res.status);
      }
      if (res.status === 401 || res.status === 403) {
        throw new LLMError(`xAI rejected the API key (HTTP ${res.status}). Check XAI_API_KEY.`, res.status);
      }
      throw new LLMError(`xAI API error (HTTP ${res.status}): ${errorDetail(raw)}`, res.status);
    }
  }

  private parse(raw: string, model: string, req: LLMRequest, started: number): LLMResponse {
    let json: { model?: string; output_text?: string; output?: OutputItem[]; usage?: ApiUsage };
    try {
      json = JSON.parse(raw);
    } catch {
      throw new LLMError("xAI returned a non-JSON response body");
    }
    const fromOutput = (json.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    const text = fromOutput || (typeof json.output_text === "string" ? json.output_text : "");
    const u = json.usage ?? {};
    const input = u.input_tokens ?? u.prompt_tokens ?? 0;
    const output = u.output_tokens ?? u.completion_tokens ?? 0;
    const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
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
