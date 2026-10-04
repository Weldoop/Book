import { describe, expect, it } from "vitest";
import { AnthropicProvider, LLMError } from "../src/index.ts";
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
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 },
  },
};

function make(responses: Parameters<typeof fakeFetch>[0], env: Record<string, string> = {}) {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const p = new AnthropicProvider({
    env: { ANTHROPIC_API_KEY: "sk-test-secret", ...env },
    fetch: f.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { p, calls: f.calls, sleeps };
}

describe("AnthropicProvider", () => {
  it("requires an API key", () => {
    expect(() => new AnthropicProvider({ env: {} })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("builds the request with headers, cache_control and tier model", async () => {
    const { p, calls } = make([OK]);
    await p.complete(req({ temperature: 0.7 }));
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.headers["x-api-key"]).toBe("sk-test-secret");
    expect(c.headers["anthropic-version"]).toBe("2023-06-01");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.body.model).toBe("claude-sonnet-4-5");
    expect(c.body.max_tokens).toBe(300);
    expect(c.body.temperature).toBe(0.7);
    expect(c.body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(c.body.system[1].cache_control).toBeUndefined();
    expect(c.body.messages).toEqual([{ role: "user", content: expect.any(String) }]);
  });

  it("maps cheap tier to the cheap model and honours env overrides", async () => {
    const { p, calls } = make([OK, OK], { BOOK_MODEL_CHEAP: "my-cheap" });
    await p.complete(req({ tier: "cheap" }));
    await p.complete(req({ tier: "strong" }));
    expect(calls[0]!.body.model).toBe("my-cheap");
    expect(calls[1]!.body.model).toBe("claude-sonnet-4-5");
  });

  it("parses text and usage, with total input including cache reads", async () => {
    const { p } = make([OK]);
    const r = await p.complete(req());
    expect(r.text).toBe("hello world");
    expect(r.usage.input_tokens).toBe(500);
    expect(r.usage.cached_input_tokens).toBe(400);
    expect(r.usage.output_tokens).toBe(50);
    // 100 fresh * 3 + 400 cached * 0.3 + 50 out * 15, per million
    expect(r.usage.cost_usd).toBeCloseTo((300 + 120 + 750) / 1e6, 10);
  });

  it("uses price overrides from env", async () => {
    const { p } = make([OK], { BOOK_PRICE_STRONG_IN: "10", BOOK_PRICE_STRONG_OUT: "20", BOOK_PRICE_STRONG_CACHED_IN: "1" });
    const r = await p.complete(req());
    expect(r.usage.cost_usd).toBeCloseTo((1000 + 400 + 1000) / 1e6, 10);
  });

  it("retries 429 and 5xx with exponential backoff, then succeeds", async () => {
    const { p, calls, sleeps } = make([{ status: 429, body: "slow down" }, { status: 503, body: "x" }, OK]);
    const r = await p.complete(req());
    expect(r.text).toBe("hello world");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after 3 retries", async () => {
    const { p, calls } = make([{ status: 500, body: { error: { type: "api_error", message: "boom" } } }]);
    await expect(p.complete(req())).rejects.toThrow(/HTTP 500.*boom/);
    expect(calls).toHaveLength(4);
  });

  it("does not retry 400 and never leaks the key", async () => {
    const { p, calls } = make([{ status: 400, body: { error: { type: "invalid_request_error", message: "bad" } } }]);
    const err = await p.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).status).toBe(400);
    expect((err as Error).message).not.toContain("sk-test-secret");
    expect(calls).toHaveLength(1);
  });

  it("explains auth failures", async () => {
    const { p } = make([{ status: 401, body: "nope" }]);
    await expect(p.complete(req())).rejects.toThrow(/rejected the API key/);
  });

  it("retries network errors", async () => {
    let n = 0;
    const p = new AnthropicProvider({
      env: { ANTHROPIC_API_KEY: "k" },
      sleep: async () => {},
      fetch: async () => {
        if (n++ === 0) throw new Error("ECONNRESET");
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(OK.body) };
      },
    });
    expect((await p.complete(req())).text).toBe("hello world");
  });
});
