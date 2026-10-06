import type { LLMProvider, LLMRequest, LLMResponse, LLMUsage } from "@book/schema";

export class MeteredProvider implements LLMProvider {
  readonly usages: LLMUsage[] = [];
  constructor(private readonly inner: LLMProvider) {}

  get name(): string {
    return this.inner.name;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const res = await this.inner.complete(req);
    this.usages.push(res.usage);
    return res;
  }
}

export function withUsageLog(provider: LLMProvider): MeteredProvider {
  return new MeteredProvider(provider);
}
