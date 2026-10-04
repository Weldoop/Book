import { describe, expect, it } from "vitest";
import { TurnDraftSchema, estimateTokens } from "@book/schema";
import { MockProvider } from "../src/index.ts";
import { req } from "./helpers.ts";

describe("MockProvider", () => {
  it("returns a stable valid turn draft echoing the input", async () => {
    const a = await new MockProvider().complete(req());
    const b = await new MockProvider().complete(req());
    expect(a.text).toBe(b.text);
    const draft = TurnDraftSchema.parse(JSON.parse(a.text));
    expect(draft.narration).toContain("Walk to the shop and buy some milk please and then go");
    expect(draft.delta).toEqual([{ op: "clock.advance", minutes: 10 }]);
  });

  it("injects faults on every Nth turn call only", async () => {
    const p = new MockProvider({ faults: { every: 3, kind: "fixable" } });
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) texts.push((await p.complete(req())).text);
    const faulty = texts.map((t) => JSON.stringify(JSON.parse(t).delta).includes('"ten"'));
    expect(faulty).toEqual([false, false, true, false, false, true]);
  });

  it("supports game_breaking and unparseable faults", async () => {
    const gb = await new MockProvider({ faults: { every: 1, kind: "game_breaking" } }).complete(req());
    expect(JSON.parse(gb.text).delta[0]).toMatchObject({ op: "stat.add", key: "money", amount: -1000000 });
    const un = await new MockProvider({ faults: { every: 1, kind: "unparseable" } }).complete(req());
    expect(() => JSON.parse(un.text)).toThrow();
  });

  it("never faults repairs and does not count them", async () => {
    const p = new MockProvider({ faults: { every: 2, kind: "game_breaking" } });
    const r1 = await p.complete(req({ purpose: "rewrite_repair" }));
    expect(JSON.parse(r1.text).delta[0].op).toBe("clock.advance");
    const d = await p.complete(req({ purpose: "delta_repair" }));
    expect(JSON.parse(d.text)).toEqual({
      delta: [{ op: "clock.advance", minutes: 5 }],
      beat: expect.any(String),
    });
    await p.complete(req());
    const second = await p.complete(req());
    expect(second.text).toContain("mock fault");
  });

  it("answers ooc and compaction in their formats", async () => {
    const p = new MockProvider();
    const ooc = await p.complete(req({ purpose: "ooc", tier: "cheap" }));
    expect(ooc.text.startsWith("[")).toBe(true);
    expect(ooc.text.endsWith("]")).toBe(true);
    const c = JSON.parse((await p.complete(req({ purpose: "compaction", tier: "cheap" }))).text);
    expect(Object.keys(c).sort()).toEqual(["chapter_summary", "facts", "resolve_threads", "story_so_far"]);
  });

  it("script overrides replies", async () => {
    const p = new MockProvider({ script: (_r, i) => (i === 1 ? "scripted" : undefined) });
    expect((await p.complete(req())).text).not.toBe("scripted");
    expect((await p.complete(req())).text).toBe("scripted");
  });

  it("meters usage, simulating caching from the second call", async () => {
    const p = new MockProvider();
    const first = await p.complete(req());
    const second = await p.complete(req());
    const staticTokens = estimateTokens("static rules ".repeat(40));
    expect(first.usage.cached_input_tokens).toBe(0);
    expect(second.usage.cached_input_tokens).toBe(staticTokens);
    expect(second.usage.input_tokens).toBeGreaterThan(staticTokens);
    expect(second.usage.output_tokens).toBe(estimateTokens(second.text));
    expect(second.usage.cost_usd).toBeLessThan(first.usage.cost_usd);
    expect(second.usage.purpose).toBe("turn");
    expect(second.usage.model).toBe("mock-strong");
  });

  it("measures latency", async () => {
    const r = await new MockProvider({ latencyMs: 15 }).complete(req());
    expect(r.usage.latency_ms).toBeGreaterThanOrEqual(10);
  });

  it("baseline_turn returns plain prose", async () => {
    const r = await new MockProvider().complete(req({ purpose: "baseline_turn" }));
    expect(() => JSON.parse(r.text)).toThrow();
  });
});
