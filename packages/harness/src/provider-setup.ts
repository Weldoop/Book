import { createProvider, withBudget } from "@book/llm";
import type { BudgetedProvider } from "@book/llm";
import type { LLMProvider } from "@book/schema";
import { flagNumber, flagString, parseFaults } from "./flags.ts";
import type { ParsedArgs } from "./flags.ts";

export interface Caps {
  maxCostUsd?: number;
  maxTotalTokens?: number;
  maxTurns?: number;
}

export interface ProviderSetup {
  name: "mock" | "anthropic";
  llm: LLMProvider;
  budget: BudgetedProvider | undefined;
  caps: Caps;
  /** Reason to stop before the next input, once a cap has been reached. */
  stopCheck(): string | undefined;
}

export function readCaps(args: ParsedArgs): Caps {
  const caps: Caps = {};
  const cost = flagNumber(args, "max-cost-usd");
  const tokens = flagNumber(args, "max-total-tokens");
  const turns = flagNumber(args, "max-turns");
  if (cost !== undefined) caps.maxCostUsd = cost;
  if (tokens !== undefined) caps.maxTotalTokens = tokens;
  if (turns !== undefined) caps.maxTurns = turns;
  return caps;
}

export function setupProvider(
  args: ParsedArgs,
  env: Record<string, string | undefined> = process.env,
  opts: { requireCapForReal?: boolean } = {},
): ProviderSetup {
  const raw = flagString(args, "provider") ?? "mock";
  if (raw !== "mock" && raw !== "anthropic") throw new Error(`Unknown --provider "${raw}". Use mock or anthropic.`);
  const caps = readCaps(args);
  const faultsSpec = flagString(args, "faults");

  if (raw === "anthropic") {
    if (opts.requireCapForReal !== false && caps.maxCostUsd === undefined && caps.maxTotalTokens === undefined && caps.maxTurns === undefined) {
      throw new Error(
        "Refusing to run against the real API without a cap. Add at least one of --max-cost-usd, --max-total-tokens or --max-turns.",
      );
    }
    if (faultsSpec !== undefined) throw new Error("--faults only works with --provider mock");
  }

  const base = createProvider(raw, env, faultsSpec ? { mock: { faults: parseFaults(faultsSpec) } } : {});
  const hasBudget = caps.maxCostUsd !== undefined || caps.maxTotalTokens !== undefined;
  const budget = hasBudget
    ? withBudget(base, {
        ...(caps.maxCostUsd !== undefined ? { maxCostUsd: caps.maxCostUsd } : {}),
        ...(caps.maxTotalTokens !== undefined ? { maxTotalTokens: caps.maxTotalTokens } : {}),
      })
    : undefined;

  return {
    name: raw,
    llm: budget ?? base,
    budget,
    caps,
    stopCheck() {
      if (!budget) return undefined;
      const s = budget.spent();
      if (caps.maxCostUsd !== undefined && s.cost_usd >= caps.maxCostUsd) {
        return `max-cost-usd $${caps.maxCostUsd} reached ($${s.cost_usd.toFixed(4)} spent)`;
      }
      if (caps.maxTotalTokens !== undefined && s.tokens >= caps.maxTotalTokens) {
        return `max-total-tokens ${caps.maxTotalTokens} reached (${s.tokens} used)`;
      }
      return undefined;
    },
  };
}
