import type { LLMProvider, LLMRequest, LLMResponse } from "@book/schema";
import { computeCost, modelFromEnv, priceFromEnv } from "./pricing.ts";

type Env = Record<string, string | undefined>;
type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface AnthropicProviderOptions {
  apiKey?: string;
  env?: Env;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  maxRetries?: number;
  backoffBaseMs?: number;
}

export class LLMError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LLMError";
    this.status = status;
  }
}

const RETRYABLE = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly env: Env;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private thinkingUnsupported = false;
  private prefillUnsupported = false;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    const key = opts.apiKey ?? this.env.ANTHROPIC_API_KEY;
    if (!key || key.trim() === "") {
      throw new LLMError("ANTHROPIC_API_KEY is not set. Export it in your shell to use the anthropic provider.");
    }
    this.apiKey = key.trim();
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com/v1/messages";
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (req.messages.length === 0) throw new LLMError("LLM request has no messages");
    const model = modelFromEnv(req.tier, this.env);
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.max_tokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.system.length > 0) {
      body.system = req.system.map((b) => ({
        type: "text",
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}),
      }));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // Hidden reasoning tokens count against max_tokens and can leave no room for the JSON reply.
    const thinkingOn = this.env.BOOK_THINKING === "on";
    if (!this.thinkingUnsupported && !thinkingOn) body.thinking = { type: "disabled" };
    // Prefill an open brace so the model cannot preface the JSON with prose. Not every model allows it,
    // and it cannot be combined with thinking.
    let prefill = req.json === true && !thinkingOn && !this.prefillUnsupported && req.messages.at(-1)?.role === "user";
    const messages = body.messages as { role: string; content: string }[];
    if (prefill) messages.push({ role: "assistant", content: "{" });
    let payload = JSON.stringify(body);

    const started = performance.now();
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await this.fetchFn(this.baseUrl, {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
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
        throw new LLMError(`Network error calling Anthropic: ${msg}`);
      }

      const raw = await res.text();
      if (res.ok) return this.parse(raw, model, req, started, prefill);

      if (RETRYABLE(res.status) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffBaseMs * 2 ** attempt;
        attempt++;
        await this.sleep(wait);
        continue;
      }
      if (res.status === 400 && body.thinking !== undefined && /thinking/i.test(raw)) {
        delete body.thinking;
        this.thinkingUnsupported = true;
        payload = JSON.stringify(body);
        continue;
      }
      if (res.status === 400 && prefill && /prefill|end with a user message/i.test(raw)) {
        messages.pop();
        prefill = false;
        this.prefillUnsupported = true;
        payload = JSON.stringify(body);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new LLMError(`Anthropic rejected the API key (HTTP ${res.status}). Check ANTHROPIC_API_KEY.`, res.status);
      }
      throw new LLMError(`Anthropic API error (HTTP ${res.status}): ${errorDetail(raw)}`, res.status);
    }
  }

  private parse(raw: string, model: string, req: LLMRequest, started: number, prefill = false): LLMResponse {
    let json: { content?: { type: string; text?: string }[]; usage?: ApiUsage; model?: string };
    try {
      json = JSON.parse(raw);
    } catch {
      throw new LLMError("Anthropic returned a non-JSON response body");
    }
    const body = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    const text = prefill && body.trim() !== "" ? `{${body}` : body;
    const u = json.usage ?? {};
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const input = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
    const output = u.output_tokens ?? 0;
    return {
      text,
      usage: {
        model: json.model ?? model,
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cacheRead,
        cost_usd: computeCost(priceFromEnv(req.tier, this.env), input, output, cacheRead, cacheWrite),
        latency_ms: Math.round(performance.now() - started),
        purpose: req.purpose,
      },
    };
  }
}
