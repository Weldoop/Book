import { describe, expect, it } from "vitest";
import { LLMError, XaiProvider, createProvider, resolveXaiModel } from "../src/index.ts";
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
    output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "hidden" }] },
      { type: "message", content: [{ type: "output_text", text: '{"narration":"Rain."}' }] },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 30 },
    },
  },
};

function make(responses: Parameters<typeof fakeFetch>[0], env: Record<string, string> = {}) {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const p = new XaiProvider({
    env: { XAI_API_KEY: "xai-test-secret", ...env },
    fetch: f.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { p, calls: f.calls, sleeps };
}

describe("XaiProvider", () => {
  it("requires an API key", () => {
    expect(() => new XaiProvider({ env: {} })).toThrow(/XAI_API_KEY/);
    expect(() => createProvider("xai", {})).toThrow(/XAI_API_KEY/);
    expect(createProvider("xai", { XAI_API_KEY: "k" }).name).toBe("xai");
  });

  it("sends a stored-off responses request and reads the message, not the reasoning", async () => {
    const { p, calls } = make([OK]);
    const r = await p.complete(req({ json: true, temperature: 0.7 }));
    const c = calls[0]!;
    expect(c.url).toBe("https://api.x.ai/v1/responses");
    expect(c.headers.authorization).toBe("Bearer xai-test-secret");
    expect(c.body.model).toBe("grok-4.7");
    expect(c.body.store).toBe(false);
    expect(c.body.reasoning).toEqual({ effort: "low" });
    expect(c.body.max_output_tokens).toBe(300);
    expect(c.body.temperature).toBe(0.7);
    expect(c.body.text).toEqual({ format: { type: "json_object" } });
    expect(c.body.input[0].role).toBe("system");
    expect(c.body.input.at(-1)).toEqual({ role: "user", content: expect.any(String) });
    expect(r.text).toBe('{"narration":"Rain."}');
    expect(r.usage.model).toBe("grok-4.7");
    expect(r.usage.input_tokens).toBe(100);
    expect(r.usage.output_tokens).toBe(50);
    expect(r.usage.cached_input_tokens).toBe(40);
    // 60 fresh at $2, 40 cached at $0.50, 50 out at $6, per million.
    expect(r.usage.cost_usd).toBeCloseTo((60 * 2 + 40 * 0.5 + 50 * 6) / 1_000_000, 9);
    expect(r.text).not.toContain("hidden");
  });

  it("uses a grok id from the env and falls back when one is missing", async () => {
    expect(resolveXaiModel("strong", {})).toBe("grok-4.7");
    expect(resolveXaiModel("strong", { BOOK_MODEL_STRONG: "claude-sonnet-4-6" })).toBe("grok-4.7");
    expect(resolveXaiModel("cheap", { BOOK_MODEL_CHEAP: "grok-4.6" })).toBe("grok-4.6");

    const missing = { status: 404, body: { error: { message: "model grok-4.9 not found" } } };
    const swapped = make([missing, OK], { BOOK_MODEL_STRONG: "grok-4.9" });
    const r = await swapped.p.complete(req());
    expect(r.text).toBe('{"narration":"Rain."}');
    expect(swapped.calls.map((c) => c.body.model)).toEqual(["grok-4.9", "grok-4.7"]);

    const down = make([missing], { BOOK_MODEL_STRONG: "grok-4.9" });
    const err = await down.p.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).toBe("The storyteller is unavailable right now. Try again in a moment.");
    expect((err as Error).message).not.toContain("xai-test-secret");
  });

  it("drops json format or reasoning when the API rejects them", async () => {
    const { p, calls } = make([
      { status: 400, body: { error: { message: "unknown text.format json_object" } } },
      { status: 400, body: { error: { message: "reasoning is not supported" } } },
      OK,
    ]);
    const r = await p.complete(req({ json: true }));
    expect(r.text).toBe('{"narration":"Rain."}');
    expect(calls[0]!.body.text).toEqual({ format: { type: "json_object" } });
    expect(calls[1]!.body.text).toBeUndefined();
    expect(calls[1]!.body.reasoning).toEqual({ effort: "low" });
    expect(calls[2]!.body.reasoning).toBeUndefined();
  });

  it("honours a reasoning effort override and retries a rate limit", async () => {
    const { p, calls, sleeps } = make(
      [{ status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "2" } }, OK],
      { BOOK_XAI_REASONING: "medium" },
    );
    await p.complete(req());
    expect(calls[0]!.body.reasoning).toEqual({ effort: "medium" });
    expect(sleeps).toEqual([2000]);
  });
});
