import type { LLMProvider } from "@book/schema";
import { AnthropicProvider } from "./anthropic.ts";
import type { AnthropicProviderOptions } from "./anthropic.ts";
import { GrokProvider } from "./grok.ts";
import type { GrokProviderOptions } from "./grok.ts";
import { MockProvider } from "./mock.ts";
import type { MockProviderOptions } from "./mock.ts";

export type ProviderName = "mock" | "anthropic" | "grok";

export interface CreateProviderOptions {
  mock?: MockProviderOptions;
  anthropic?: AnthropicProviderOptions;
  grok?: GrokProviderOptions;
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
  if (name === "grok") {
    if (!env.XAI_API_KEY && !opts.grok?.apiKey) {
      throw new Error("The grok provider needs an API key. Set the XAI_API_KEY environment variable.");
    }
    return new GrokProvider({ ...opts.grok, env });
  }
  throw new Error(`Unknown provider "${String(name)}". Use "mock", "anthropic", or "grok".`);
}
