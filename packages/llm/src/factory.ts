import type { LLMProvider } from "@book/schema";
import { AnthropicProvider } from "./anthropic.ts";
import type { AnthropicProviderOptions } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import type { MockProviderOptions } from "./mock.ts";

export type ProviderName = "mock" | "anthropic";

export interface CreateProviderOptions {
  mock?: MockProviderOptions;
  anthropic?: AnthropicProviderOptions;
}

export function createProvider(
  name: ProviderName,
  env: Record<string, string | undefined> = process.env,
  opts: CreateProviderOptions = {},
): LLMProvider {
  if (name === "mock") return new MockProvider(opts.mock);
  if (name === "anthropic") {
    if (!env.ANTHROPIC_API_KEY && !opts.anthropic?.apiKey) {
      throw new Error("The anthropic provider needs an API key. Set the ANTHROPIC_API_KEY environment variable.");
    }
    return new AnthropicProvider({ ...opts.anthropic, env });
  }
  throw new Error(`Unknown provider "${String(name)}". Use "mock" or "anthropic".`);
}
