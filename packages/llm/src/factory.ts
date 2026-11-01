import type { LLMProvider } from "@book/schema";
import { AnthropicProvider } from "./anthropic.ts";
import type { AnthropicProviderOptions } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import type { MockProviderOptions } from "./mock.ts";
import { XaiProvider } from "./xai.ts";
import type { XaiProviderOptions } from "./xai.ts";

export type ProviderName = "mock" | "anthropic" | "xai";

export interface CreateProviderOptions {
  mock?: MockProviderOptions;
  anthropic?: AnthropicProviderOptions;
  xai?: XaiProviderOptions;
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
  if (name === "xai") {
    if (!env.XAI_API_KEY && !opts.xai?.apiKey) {
      throw new Error("The xai provider needs an API key. Set the XAI_API_KEY environment variable.");
    }
    return new XaiProvider({ ...opts.xai, env });
  }
  throw new Error(`Unknown provider "${String(name)}". Use "mock", "anthropic", or "xai".`);
}
