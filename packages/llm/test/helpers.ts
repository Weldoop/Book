import type { LLMRequest } from "@book/schema";

export function req(over: Partial<LLMRequest> = {}): LLMRequest {
  return {
    tier: "strong",
    system: [
      { text: "static rules ".repeat(40), cache: true },
      { text: "dynamic part" },
    ],
    messages: [{ role: "user", content: "Walk to the shop and buy some milk please and then go home again" }],
    max_tokens: 300,
    purpose: "turn",
    ...over,
  };
}
