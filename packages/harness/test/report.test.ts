import { describe, expect, it } from "vitest";
import {
  ReportSchema,
  buildReport,
  compareReports,
  computeTotals,
  formatComparison,
  formatReport,
  formatTurnLine,
  inputTokensAtTurn,
  percentile,
} from "../src/index.ts";
import type { TurnRow } from "../src/index.ts";

function row(turn: number, input: number, over: Partial<TurnRow> = {}): TurnRow {
  return {
    turn,
    input_tokens: input,
    output_tokens: 100,
    cached_input_tokens: 0,
    cost_usd: 0.01,
    latency_ms: 1000,
    outcome: "ok",
    calls: 1,
    ...over,
  };
}

describe("percentile", () => {
  it("uses nearest rank", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });
  it("does not need sorted input or mutate it", () => {
    const v = [9, 1, 5];
    expect(percentile(v, 50)).toBe(5);
    expect(v).toEqual([9, 1, 5]);
  });
});

describe("computeTotals", () => {
  it("sums, averages and computes rates", () => {
    const rows = [
      row(1, 100),
      row(2, 200, { outcome: "repaired", calls: 2, cost_usd: 0.03 }),
      row(3, 300, { outcome: "rewritten", interlude: true, calls: 3 }),
      row(4, 400, { outcome: "rolled_back", calls: 3 }),
    ];
    const t = computeTotals(rows);
    expect(t.turns).toBe(4);
    expect(t.calls).toBe(9);
    expect(t.input_tokens).toBe(1000);
    expect(t.avg_input_tokens).toBe(250);
    expect(t.p50_input_tokens).toBe(200);
    expect(t.p95_input_tokens).toBe(400);
    expect(t.cost_usd).toBeCloseTo(0.06);
    expect(t.repair_rate).toBe(0.75);
    expect(t.interlude_rate).toBe(0.25);
    expect(t.rollback_rate).toBe(0.25);
    expect(t.attention_misses).toBeUndefined();
  });

  it("handles empty runs and attention misses and probes", () => {
    expect(computeTotals([]).avg_input_tokens).toBe(0);
    const t = computeTotals([row(1, 1, { attention_misses: 2 }), row(2, 1)], [
      { after_turn: 1, question: "q", passed: true, answer: "a" },
      { after_turn: 2, question: "q", passed: false, answer: "a" },
      { after_turn: 3, question: "q", passed: true, answer: "a" },
      { after_turn: 4, question: "q", passed: true, answer: "a" },
    ]);
    expect(t.attention_misses).toBe(2);
    expect(t.probe_pass_rate).toBe(0.75);
    expect(t.probes_total).toBe(4);
  });
});

function report(kind: "engine" | "baseline", inputs: number[], over: Partial<TurnRow> = {}) {
  return buildReport({
    kind,
    fixture: "fx",
    provider: "mock",
    config_id: "c",
    started_at: "2026-10-04T00:00:00.000Z",
    turns: inputs.map((n, i) => row(i + 1, n, over)),
  });
}

describe("buildReport / schema", () => {
  it("produces JSON that satisfies ReportSchema", () => {
    const r = report("engine", [10, 20, 30]);
    expect(ReportSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(r.probes).toBeUndefined();
  });
  it("carries stopped_reason", () => {
    const r = buildReport({ kind: "baseline", fixture: "f", provider: "p", config_id: "c", started_at: "x", turns: [], stopped_reason: "cap" });
    expect(r.stopped_reason).toBe("cap");
  });
  it("rejects malformed reports", () => {
    expect(ReportSchema.safeParse({ kind: "other" }).success).toBe(false);
  });
});

describe("compareReports", () => {
  it("computes ratios and milestone lookups", () => {
    const baseline = report("baseline", Array.from({ length: 130 }, (_, i) => (i + 1) * 100));
    const engine = report("engine", Array.from({ length: 60 }, () => 1000));
    const c = compareReports(baseline, engine);
    const sumBase = (130 * 131 * 100) / 2;
    expect(c.cumulative_input.a).toBe(sumBase);
    expect(c.cumulative_input.b).toBe(60000);
    expect(c.cumulative_input.ratio).toBeCloseTo(60000 / sumBase);
    expect(c.at_turn.map((m) => [m.turn, m.a, m.b])).toEqual([
      [25, 2500, 1000],
      [50, 5000, 1000],
      [100, 10000, undefined],
      [125, 12500, undefined],
    ]);
    expect(c.at_turn[0]?.ratio).toBeCloseTo(0.4);
    expect(c.at_turn[2]?.ratio).toBeNull();
  });

  it("handles zero denominators", () => {
    const c = compareReports(report("baseline", [0]), report("engine", [5]));
    expect(c.cumulative_input.ratio).toBeNull();
  });

  it("looks up the final attempt when a turn number repeats", () => {
    const r = buildReport({
      kind: "engine", fixture: "f", provider: "p", config_id: "c", started_at: "x",
      turns: [row(1, 10), row(2, 99, { outcome: "rolled_back" }), row(2, 20)],
    });
    expect(inputTokensAtTurn(r, 2)).toBe(20);
  });
});

describe("formatting", () => {
  it("formats a turn line", () => {
    const l = formatTurnLine(row(7, 1234, { cached_input_tokens: 500, latency_ms: 2500, outcome: "repaired" }));
    expect(l).toBe("t007  in 1,234  out 100  cached 500  $0.0100  2.5s  repaired");
  });
  it("formats a report and a comparison", () => {
    const e = report("engine", [1000, 1000]);
    const b = report("baseline", [1000, 2000]);
    const text = formatReport(e);
    expect(text).toContain("engine report");
    expect(text).toContain("p95");
    expect(text).toContain("25=-");
    const cmp = formatComparison(compareReports(b, e));
    expect(cmp).toContain("cumulative input tokens");
    expect(cmp).toContain("0.67x");
    expect(cmp).toContain("input at turn 125");
  });
});
