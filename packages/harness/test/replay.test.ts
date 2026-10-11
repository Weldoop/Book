import { describe, expect, it } from "vitest";
import { MockProvider, withBudget } from "@book/llm";
import { MemoryStore } from "@book/store";
import { runBaseline, runReplay, scoreProbe, dueProbes, parseFixture, parseProbes, setupProvider, parseFlags } from "../src/index.ts";
import type { Probe } from "../src/index.ts";
import { fakeRuntimeApi, fixture, makeConfig } from "./helpers.ts";

const base = () => ({ config: makeConfig(), store: new MemoryStore(), saveId: "s", providerName: "mock" });

describe("runReplay with a fake runtime", () => {
  it("runs each input and derives per-turn numbers from record.usage", async () => {
    const lines: string[] = [];
    const api = fakeRuntimeApi({ outcomeFor: (t) => (t === 2 ? "repaired" : "ok") });
    const r = await runReplay({ ...base(), api, llm: new MockProvider(), fixture: fixture(3), onLine: (l) => lines.push(l) });
    expect(r.kind).toBe("engine");
    expect(r.turns.map((t) => t.turn)).toEqual([1, 2, 3]);
    expect(r.turns[1]?.calls).toBe(2);
    expect(r.turns[1]?.outcome).toBe("repaired");
    expect(r.turns[0]?.calls).toBe(1);
    expect(r.turns[0]?.input_tokens).toBeGreaterThan(0);
    expect(r.turns[0]?.context_parts).toEqual([{ name: "static", tokens: 100, trimmed: false }]);
    expect(r.totals.repair_rate).toBeCloseTo(1 / 3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^t001 /);
    expect(r.stopped_reason).toBeUndefined();
  });

  it("counts interludes and rollbacks", async () => {
    const api = fakeRuntimeApi({ outcomeFor: (_t, i) => (i.endsWith(" 1") ? "rewritten" : i.endsWith(" 2") ? "rolled_back" : "ok") });
    const r = await runReplay({ ...base(), api, llm: new MockProvider(), fixture: fixture(3) });
    expect(r.totals.interlude_turns).toBe(1);
    expect(r.totals.rolled_back_turns).toBe(1);
    expect(r.turns.map((t) => [t.turn, t.game_turn])).toEqual([[1, 1], [2, 1], [3, 2]]);
  });

  it("passes deltaFirst through to createRuntime", async () => {
    const api = fakeRuntimeApi();
    await runReplay({ ...base(), api, llm: new MockProvider(), fixture: fixture(1), deltaFirst: true });
    expect(api.created[0]).toMatchObject({ deltaFirst: true });
    const api2 = fakeRuntimeApi();
    await runReplay({ ...base(), api: api2, llm: new MockProvider(), fixture: fixture(1) });
    expect(api2.created[0]).not.toHaveProperty("deltaFirst");
  });

  it("stops at max-turns", async () => {
    const api = fakeRuntimeApi();
    const r = await runReplay({ ...base(), api, llm: new MockProvider(), fixture: fixture(10), maxTurns: 4 });
    expect(r.turns).toHaveLength(4);
    expect(r.stopped_reason).toMatch(/max-turns 4/);
  });

  it("stops when the budget is exhausted, even if the runtime propagates the error", async () => {
    const api = fakeRuntimeApi();
    const llm = withBudget(new MockProvider(), { maxTotalTokens: 1200 });
    const r = await runReplay({ ...base(), api, llm, fixture: fixture(50) });
    expect(r.turns.length).toBeGreaterThan(0);
    expect(r.turns.length).toBeLessThan(50);
    expect(r.stopped_reason).toMatch(/Token budget exceeded/);
  });

  it("stops via stopCheck before the next input", async () => {
    const api = fakeRuntimeApi();
    let n = 0;
    const r = await runReplay({
      ...base(), api, llm: new MockProvider(), fixture: fixture(10),
      stopCheck: () => (n++ >= 2 ? "cap hit" : undefined),
    });
    expect(r.turns).toHaveLength(2);
    expect(r.stopped_reason).toBe("cap hit");
  });

  it("rethrows unexpected runtime errors", async () => {
    const api = fakeRuntimeApi({ throwAt: 2 });
    await expect(runReplay({ ...base(), api, llm: new MockProvider(), fixture: fixture(3) })).rejects.toThrow(/exploded/);
  });

  it("asks probes as OOC turns after the right input and scores them", async () => {
    const api = fakeRuntimeApi({ answers: (i) => (i.includes("name") ? "The tutor is called Dai." : "no idea") });
    const probes: Probe[] = [
      { after_turn: 2, question: "What is the tutor's name?", expect_any: ["dai", "weldon"] },
      { after_turn: 3, question: "Where do you live?", expect_any: ["cardiff"] },
      { after_turn: 99, question: "never reached", expect_any: ["x"] },
    ];
    const r = await runReplay({ ...base(), api, llm: new MockProvider(), fixture: fixture(3), probes });
    expect(api.calls).toEqual([
      "action number 1",
      "action number 2",
      "OOC: What is the tutor's name?",
      "action number 3",
      "OOC: Where do you live?",
    ]);
    expect(r.probes?.map((p) => [p.after_turn, p.passed])).toEqual([[2, true], [3, false]]);
    expect(r.totals.probe_pass_rate).toBe(0.5);
    expect(r.turns).toHaveLength(3);
  });
});

describe("probe helpers", () => {
  it("scores case-insensitively with any keyword", () => {
    expect(scoreProbe("It was DAI who came", ["dai"])).toBe(true);
    expect(scoreProbe("nobody", ["dai", "glenys"])).toBe(false);
    expect(scoreProbe("No one called Dai came", ["dai"])).toBe(false);
    expect(scoreProbe("You don't know a Nathan", ["nathan"])).toBe(false);
    expect(scoreProbe("Dai didn't come", ["dai"])).toBe(false);
    expect(scoreProbe("It was never Dai", ["dai"])).toBe(false);
    expect(scoreProbe("You don't know the time. It was Dai.", ["dai"])).toBe(true);
    expect(
      scoreProbe(
        "You bought oat milk and a pint of milk at the shops on Uplands Crescent (not specifically the Co-op).",
        ["milk"],
      ),
    ).toBe(true);
    expect(scoreProbe("Dai is not coming", ["dai"])).toBe(false);
    expect(scoreProbe("The garden blitz happened with Cerys, but no deal.", ["rys", "rhys", "rees"])).toBe(false);
    expect(scoreProbe("His name is Nathan", ["nath"])).toBe(false);
    expect(scoreProbe("His name is Nathan", ["nathan", "nath"])).toBe(true);
  });
  it("dueProbes returns each probe once when reached", () => {
    const p: Probe[] = [
      { after_turn: 5, question: "a", expect_any: ["x"] },
      { after_turn: 10, question: "b", expect_any: ["x"] },
    ];
    const asked = new Set<Probe>();
    expect(dueProbes(p, asked, 4)).toEqual([]);
    const d = dueProbes(p, asked, 7);
    expect(d).toHaveLength(1);
    asked.add(p[0] as Probe);
    expect(dueProbes(p, asked, 12).map((x) => x.question)).toEqual(["b"]);
  });
  it("validates fixture and probe files", () => {
    expect(parseFixture({ id: "f", inputs: [{ turn: 2, text: "b" }, { turn: 1, text: "a" }] }).inputs[0]?.text).toBe("a");
    expect(() => parseFixture({ id: "f", inputs: [] })).toThrow(/not a valid fixture/);
    expect(() => parseProbes([{ after_turn: 1, question: "q", expect_any: [] }])).toThrow(/not a valid probes/);
    expect(parseProbes([{ after_turn: 9, question: "b", expect_any: ["x"] }, { after_turn: 1, question: "a", expect_any: ["x"] }])[0]?.question).toBe("a");
  });
});

describe("runBaseline", () => {
  it("resends all history, so input tokens grow with the turn number", async () => {
    const llm = new MockProvider();
    const r = await runBaseline({ config: makeConfig(), llm, fixture: fixture(30), providerName: "mock" });
    expect(r.kind).toBe("baseline");
    expect(r.turns).toHaveLength(30);
    const inputs = r.turns.map((t) => t.input_tokens);
    for (let i = 1; i < inputs.length; i++) expect(inputs[i]).toBeGreaterThan(inputs[i - 1] as number);
    expect(inputs[29]).toBeGreaterThan((inputs[0] as number) * 3);
    expect(r.totals.calls).toBe(30);
    expect(r.turns.every((t) => t.outcome === "ok" && t.calls === 1)).toBe(true);
  });

  it("uses purpose baseline_turn on the strong tier with all prior messages", async () => {
    const seen: { purpose: string; tier: string; n: number; system: string }[] = [];
    const inner = new MockProvider();
    const llm = {
      name: "spy",
      complete: async (req: Parameters<MockProvider["complete"]>[0]) => {
        seen.push({ purpose: req.purpose, tier: req.tier, n: req.messages.length, system: req.system.map((s) => s.text).join("\n") });
        return inner.complete(req);
      },
    };
    await runBaseline({ config: makeConfig(), llm, fixture: fixture(3), providerName: "spy" });
    expect(seen.map((s) => s.n)).toEqual([1, 3, 5]);
    expect(seen.every((s) => s.purpose === "baseline_turn" && s.tier === "strong")).toBe(true);
    expect(seen[0]?.system).toContain("wry and grounded");
    expect(seen[0]?.system).toContain("money | health | place | time");
  });

  it("scores probes without adding them to history, and honours caps", async () => {
    const probes: Probe[] = [{ after_turn: 2, question: "What was action number 1?", expect_any: ["action number 1"] }];
    const r = await runBaseline({ config: makeConfig(), llm: new MockProvider(), fixture: fixture(5), probes, providerName: "mock", maxTurns: 3 });
    expect(r.turns).toHaveLength(3);
    expect(r.probes?.[0]?.passed).toBe(true);
    expect(r.stopped_reason).toMatch(/max-turns/);
    const llm = withBudget(new MockProvider(), { maxTotalTokens: 800 });
    const r2 = await runBaseline({ config: makeConfig(), llm, fixture: fixture(50), providerName: "mock" });
    expect(r2.turns.length).toBeLessThan(50);
    expect(r2.stopped_reason).toMatch(/budget/i);
  });

  it("engine vs baseline: flat engine context beats growing baseline", async () => {
    const f = fixture(40);
    const b = await runBaseline({ config: makeConfig(), llm: new MockProvider(), fixture: f, providerName: "mock" });
    const e = await runReplay({ ...base(), api: fakeRuntimeApi(), llm: new MockProvider(), fixture: f });
    expect(e.totals.input_tokens).toBeLessThan(b.totals.input_tokens);
  });
});

describe("setupProvider", () => {
  const args = (...a: string[]) => parseFlags(["replay", ...a]);
  it("defaults to mock and applies faults", () => {
    const s = setupProvider(args("--faults", "every=2,kind=fixable"), {});
    expect(s.name).toBe("mock");
    expect(s.budget).toBeUndefined();
    expect(s.stopCheck()).toBeUndefined();
  });
  it("refuses the real API without a cap", () => {
    expect(() => setupProvider(args("--provider", "anthropic"), { ANTHROPIC_API_KEY: "k" })).toThrow(/without a cap/);
  });
  it("requires the key even with a cap", () => {
    expect(() => setupProvider(args("--provider", "anthropic", "--max-turns", "3"), {})).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("accepts any single cap", () => {
    for (const cap of [["--max-cost-usd", "0.5"], ["--max-total-tokens", "1000"], ["--max-turns", "3"]]) {
      expect(setupProvider(args("--provider", "anthropic", ...(cap as string[])), { ANTHROPIC_API_KEY: "k" }).name).toBe("anthropic");
    }
  });
  it("rejects faults on the real provider and unknown providers", () => {
    expect(() => setupProvider(args("--provider", "anthropic", "--max-turns", "1", "--faults", "kind=fixable"), { ANTHROPIC_API_KEY: "k" })).toThrow(/mock/);
    expect(() => setupProvider(args("--provider", "gpt"), {})).toThrow(/Unknown --provider/);
  });
  it("stopCheck fires once the budget is spent", async () => {
    const s = setupProvider(args("--max-total-tokens", "20"), {});
    expect(s.stopCheck()).toBeUndefined();
    await s.llm.complete({ tier: "strong", system: [], messages: [{ role: "user", content: "hi" }], max_tokens: 10, purpose: "turn" });
    expect(s.stopCheck()).toMatch(/max-total-tokens/);
  });
});
