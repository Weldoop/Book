export type LLMTier = "strong" | "cheap";

export interface LLMSystemBlock {
  text: string;
  /** Static blocks that providers may cache. Put these first. */
  cache?: boolean;
}

export interface LLMRequest {
  tier: LLMTier;
  system: LLMSystemBlock[];
  messages: { role: "user" | "assistant"; content: string }[];
  max_tokens: number;
  temperature?: number;
  /** Hint that the reply must be a single JSON object. */
  json?: boolean;
  /** Free-form label for usage logs, for example "turn", "delta_repair", "compaction". */
  purpose: string;
}

export interface LLMUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
  latency_ms: number;
  purpose: string;
}

export interface LLMResponse {
  text: string;
  usage: LLMUsage;
}

export interface LLMProvider {
  name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}
