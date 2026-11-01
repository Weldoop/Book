import { describe, expect, it } from "vitest";
import { GrokProvider, LLMError, grokModel } from "../src/index.ts";
import { req } from "./helpers.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
  return { fn, calls };
}

const OK = {
  status: 200,
  body: {
    model: "grok-4.7",
    choices: [{ message: { role: "assistant", content: '{"narration":"Rain."}' } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  },
};

function make(responses: Parameters<typeof fakeFetch>[0], env: Record<string, string> = {}) {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const p = new GrokProvider({
    env: { XAI_API_KEY: "xai-test-secret", ...env },
    fetch: f.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { p, calls: f.calls, sleeps };
}

describe("GrokProvider", () => {
  it("requires an API key", () => {
    expect(() => new GrokProvider({ env: {} })).toThrow(/XAI_API_KEY/);
  });

  it("ignores a Claude model id and uses the grok defaults", () => {
    expect(grokModel("strong", { BOOK_MODEL_STRONG: "claude-sonnet-4-6" })).toBe("grok-4.7");
    expect(grokModel("cheap", {})).toBe("grok-4.3");
    expect(grokModel("strong", { BOOK_MODEL_STRONG: "grok-4.6" })).toBe("grok-4.6");
  });

  it("builds a chat completion with a bearer key, low reasoning, and json mode", async () => {
    const { p, calls } = make([OK]);
    await p.complete(req({ json: true, temperature: 0.4 }));
    const c = calls[0]!;
    expect(c.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(c.headers.authorization).toBe("Bearer xai-test-secret");
    expect(c.body.model).toBe("grok-4.7");
    expect(c.body.max_tokens).toBe(300);
    expect(c.body.temperature).toBe(0.4);
    expect(c.body.reasoning_effort).toBe("low");
    expect(c.body.response_format).toEqual({ type: "json_object" });
    expect(c.body.messages[0]).toEqual({ role: "system", content: expect.stringContaining("static rules") });
    expect(c.body.messages.at(-1)).toEqual({ role: "user", content: expect.any(String) });
  });

  it("honours a grok model override and a reasoning override", async () => {
    const { p, calls } = make([OK, OK], { BOOK_MODEL_CHEAP: "grok-4.20-0309-non-reasoning", BOOK_GROK_REASONING: "high" });
    await p.complete(req({ tier: "cheap" }));
    expect(calls[0]!.body.model).toBe("grok-4.20-0309-non-reasoning");
    expect(calls[0]!.body.reasoning_effort).toBe("high");
  });

  it("bills visible completion and reasoning tokens, with cached input at the grok rate", async () => {
    const { p } = make([OK]);
    const result = await p.complete(req());
    expect(result.text).toBe('{"narration":"Rain."}');
    expect(result.usage.output_tokens).toBe(50);
    expect(result.usage.cached_input_tokens).toBe(25);
    // 75 fresh in at $2, 25 cached at $0.50, 50 out at $6 per million.
    expect(result.usage.cost_usd).toBeCloseTo((75 * 2 + 25 * 0.5 + 50 * 6) / 1_000_000, 9);
  });

  it("retries a missing model once on the tier default and hides the raw error", async () => {
    const missing = { status: 404, body: { error: { message: "model grok-9 not found" } } };
    const swapped = make([missing, OK], { BOOK_MODEL_STRONG: "grok-9" });
    const result = await swapped.p.complete(req());
    expect(result.text).toBe('{"narration":"Rain."}');
    expect(swapped.calls.map((c) => c.body.model)).toEqual(["grok-9", "grok-4.7"]);

    const down = make([missing], { BOOK_MODEL_STRONG: "grok-4.7" });
    const err = await down.p.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).toBe("The storyteller is unavailable right now. Try again in a moment.");
    expect((err as Error).message).not.toContain("xai-test-secret");
  });

  it("does not leak the key when the API rejects it", async () => {
    const { p } = make([{ status: 401, body: { error: "bad key xai-test-secret" } }]);
    const err = await p.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).toMatch(/XAI_API_KEY/);
    expect((err as Error).message).not.toContain("xai-test-secret");
  });

  it("redacts the key from an error body", async () => {
    const { p } = make([{ status: 400, body: { error: { message: "upstream said xai-test-secret" } } }]);
    const err = await p.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).toContain("[redacted]");
    expect((err as Error).message).not.toContain("xai-test-secret");
  });

  it("retries a rate limit, then drops an unsupported reasoning field", async () => {
    const limited = make(
      [
        { status: 429, body: { error: "slow down" }, headers: { "retry-after": "2" } },
        { status: 400, body: { error: { message: "reasoning_effort is not supported" } } },
        OK,
      ],
    );
    const result = await limited.p.complete(req());
    expect(result.text).toBe('{"narration":"Rain."}');
    expect(limited.sleeps).toEqual([2000]);
    expect(limited.calls[2]!.body.reasoning_effort).toBeUndefined();
  });

  it("joins array message content", async () => {
    const { p } = make([
      {
        status: 200,
        body: {
          model: "grok-4.3",
          choices: [{ message: { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
      },
    ]);
    const result = await p.complete(req({ tier: "cheap" }));
    expect(result.text).toBe("onetwo");
    expect(result.usage.model).toBe("grok-4.3");
    expect(result.usage.cost_usd).toBeCloseTo((10 * 1.25 + 2 * 2.5) / 1_000_000, 9);
  });
});
