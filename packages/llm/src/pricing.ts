import type { LLMTier } from "@book/schema";

/** USD per million tokens. */
export interface Price {
  in: number;
  out: number;
  cached_in: number;
}

export const DEFAULT_PRICES: Record<LLMTier, Price> = {
  strong: { in: 3, out: 15, cached_in: 0.3 },
  cheap: { in: 1, out: 5, cached_in: 0.1 },
};

export const DEFAULT_MODELS: Record<LLMTier, string> = {
  strong: "claude-sonnet-4-6",
  cheap: "claude-haiku-4-5-20251001",
};

type Env = Record<string, string | undefined>;

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Published list prices by model family, so a tier pointed at another model is costed at that model's rate. */
const MODEL_PRICES: [RegExp, Price][] = [
  [/haiku-4/, { in: 1, out: 5, cached_in: 0.1 }],
  [/haiku/, { in: 0.8, out: 4, cached_in: 0.08 }],
  [/opus/, { in: 15, out: 75, cached_in: 1.5 }],
  [/sonnet/, { in: 3, out: 15, cached_in: 0.3 }],
];

export function priceForModel(model: string): Price | undefined {
  const id = model.toLowerCase();
  return MODEL_PRICES.find(([re]) => re.test(id))?.[1];
}

/** Reads BOOK_PRICE_{STRONG|CHEAP}_{IN|OUT|CACHED_IN}; otherwise the price of the model the tier resolves to. */
export function priceFromEnv(tier: LLMTier, env: Env, model?: string): Price {
  const t = tier.toUpperCase();
  const base = (model ? priceForModel(model) : undefined) ?? DEFAULT_PRICES[tier];
  return {
    in: num(env[`BOOK_PRICE_${t}_IN`], base.in),
    out: num(env[`BOOK_PRICE_${t}_OUT`], base.out),
    cached_in: num(env[`BOOK_PRICE_${t}_CACHED_IN`], base.cached_in),
  };
}

export function modelFromEnv(tier: LLMTier, env: Env): string {
  const v = env[`BOOK_MODEL_${tier.toUpperCase()}`];
  return v && v.trim() !== "" ? v.trim() : DEFAULT_MODELS[tier];
}

/**
 * Ids that 404 on the current API. They resolve to the tier default before the request,
 * so a saved config that still says `claude-sonnet-4-5` does not reach the player as an error.
 */
const RETIRED_MODELS: Record<string, string> = {
  "claude-sonnet-4-5": DEFAULT_MODELS.strong,
  "claude-sonnet-4-5-20250929": DEFAULT_MODELS.strong,
  "claude-3-5-sonnet-latest": DEFAULT_MODELS.strong,
  "claude-3-5-sonnet-20241022": DEFAULT_MODELS.strong,
  "claude-3-7-sonnet-latest": DEFAULT_MODELS.strong,
  "claude-3-7-sonnet-20250219": DEFAULT_MODELS.strong,
  "claude-3-5-haiku-latest": DEFAULT_MODELS.cheap,
  "claude-3-5-haiku-20241022": DEFAULT_MODELS.cheap,
};

export function resolveModel(tier: LLMTier, env: Env): string {
  const requested = modelFromEnv(tier, env);
  return RETIRED_MODELS[requested] ?? requested;
}

/**
 * `inputTokens` is the total input including cached reads; `cachedInputTokens` is the cached subset.
 * `cacheWriteTokens` are billed at 1.25x the normal input price (Anthropic ephemeral cache).
 */
export function computeCost(
  price: Price,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheWriteTokens = 0,
): number {
  const cached = Math.min(cachedInputTokens, inputTokens);
  const fresh = Math.max(0, inputTokens - cached - cacheWriteTokens);
  const usd =
    (fresh * price.in + cacheWriteTokens * price.in * 1.25 + cached * price.cached_in + outputTokens * price.out) /
    1_000_000;
  return usd;
}
