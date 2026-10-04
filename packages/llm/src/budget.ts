import { estimateTokens } from "@book/schema";
import type { LLMProvider, LLMRequest, LLMResponse } from "@book/schema";

export interface BudgetCaps {
  maxTotalTokens?: number;
  maxCostUsd?: number;
}

export class BudgetExceededError extends Error {
  readonly cap: "tokens" | "cost_usd";
  readonly limit: number;
  readonly spent: { tokens: number; cost_usd: number };
  constructor(cap: "tokens" | "cost_usd", limit: number, spent: { tokens: number; cost_usd: number }) {
    super(
      cap === "tokens"
        ? `Token budget exceeded: ${spent.tokens} used, cap ${limit}`
        : `Cost budget exceeded: $${spent.cost_usd.toFixed(4)} used, cap $${limit}`,
    );
    this.name = "BudgetExceededError";
    this.cap = cap;
    this.limit = limit;
    this.spent = spent;
  }
}

export type BudgetedProvider = LLMProvider & { spent(): { tokens: number; cost_usd: number } };

export function withBudget(provider: LLMProvider, caps: BudgetCaps): BudgetedProvider {
  let tokens = 0;
  let cost = 0;
  const spent = (): { tokens: number; cost_usd: number } => ({ tokens, cost_usd: cost });

  const check = (estimatedInput: number): void => {
    const { maxTotalTokens, maxCostUsd } = caps;
    if (maxTotalTokens !== undefined && tokens + estimatedInput > maxTotalTokens) {
      throw new BudgetExceededError("tokens", maxTotalTokens, spent());
    }
    if (maxCostUsd !== undefined && cost >= maxCostUsd) {
      throw new BudgetExceededError("cost_usd", maxCostUsd, spent());
    }
  };

  const estimateInput = (req: LLMRequest): number =>
    req.system.reduce((n, b) => n + estimateTokens(b.text), 0) +
    req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);

  return {
    name: provider.name,
    spent,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      check(estimateInput(req));
      const res = await provider.complete(req);
      tokens += res.usage.input_tokens + res.usage.output_tokens;
      cost += res.usage.cost_usd;
      return res;
    },
  };
}
