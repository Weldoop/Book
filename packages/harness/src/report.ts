import { z } from "zod";

export const ContextPartSchema = z.object({ name: z.string(), tokens: z.number(), trimmed: z.boolean() });

export const TurnRowSchema = z.object({
  /** Fixture input number, comparable across engine and baseline. */
  turn: z.number().int(),
  /** The engine's own turn counter after this input (engine reports only). */
  game_turn: z.number().int().optional(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cached_input_tokens: z.number(),
  cost_usd: z.number(),
  latency_ms: z.number(),
  outcome: z.string(),
  calls: z.number().int(),
  interlude: z.boolean().optional(),
  attention_misses: z.number().int().optional(),
  context_parts: z.array(ContextPartSchema).optional(),
});
export type TurnRow = z.infer<typeof TurnRowSchema>;

export const ProbeResultSchema = z.object({
  after_turn: z.number().int(),
  question: z.string(),
  passed: z.boolean(),
  answer: z.string(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cost_usd: z.number().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const TotalsSchema = z.object({
  turns: z.number().int(),
  calls: z.number().int(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cached_input_tokens: z.number(),
  cost_usd: z.number(),
  latency_ms: z.number(),
  avg_input_tokens: z.number(),
  p50_input_tokens: z.number(),
  p95_input_tokens: z.number(),
  repaired_turns: z.number().int(),
  interlude_turns: z.number().int(),
  rolled_back_turns: z.number().int(),
  repair_rate: z.number(),
  interlude_rate: z.number(),
  rollback_rate: z.number(),
  attention_misses: z.number().int().optional(),
  probes_total: z.number().int().optional(),
  probes_passed: z.number().int().optional(),
  probe_pass_rate: z.number().optional(),
});
export type Totals = z.infer<typeof TotalsSchema>;

/** Totals cover story turns only; probe calls are listed separately under `probes`. */
export const ReportSchema = z.object({
  kind: z.enum(["engine", "baseline"]),
  fixture: z.string(),
  provider: z.string(),
  config_id: z.string(),
  started_at: z.string(),
  stopped_reason: z.string().optional(),
  turns: z.array(TurnRowSchema),
  probes: z.array(ProbeResultSchema).optional(),
  totals: TotalsSchema,
});
export type Report = z.infer<typeof ReportSchema>;

export interface BuildReportInput {
  kind: Report["kind"];
  fixture: string;
  provider: string;
  config_id: string;
  started_at: string;
  turns: TurnRow[];
  probes?: ProbeResult[];
  stopped_reason?: string;
}

/** Nearest-rank percentile; `p` in 0..100. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

function sum(rows: TurnRow[], pick: (r: TurnRow) => number): number {
  return rows.reduce((n, r) => n + pick(r), 0);
}

export function computeTotals(turns: TurnRow[], probes?: ProbeResult[]): Totals {
  const n = turns.length;
  const inputs = turns.map((t) => t.input_tokens);
  const rate = (count: number): number => (n === 0 ? 0 : count / n);
  const repaired = turns.filter((t) => t.outcome !== "ok").length;
  const interludes = turns.filter((t) => t.interlude).length;
  const rolled = turns.filter((t) => t.outcome === "rolled_back").length;
  const totals: Totals = {
    turns: n,
    calls: sum(turns, (t) => t.calls),
    input_tokens: sum(turns, (t) => t.input_tokens),
    output_tokens: sum(turns, (t) => t.output_tokens),
    cached_input_tokens: sum(turns, (t) => t.cached_input_tokens),
    cost_usd: sum(turns, (t) => t.cost_usd),
    latency_ms: sum(turns, (t) => t.latency_ms),
    avg_input_tokens: n === 0 ? 0 : sum(turns, (t) => t.input_tokens) / n,
    p50_input_tokens: percentile(inputs, 50),
    p95_input_tokens: percentile(inputs, 95),
    repaired_turns: repaired,
    interlude_turns: interludes,
    rolled_back_turns: rolled,
    repair_rate: rate(repaired),
    interlude_rate: rate(interludes),
    rollback_rate: rate(rolled),
  };
  if (turns.some((t) => t.attention_misses !== undefined)) {
    totals.attention_misses = sum(turns, (t) => t.attention_misses ?? 0);
  }
  if (probes && probes.length > 0) {
    const passed = probes.filter((p) => p.passed).length;
    totals.probes_total = probes.length;
    totals.probes_passed = passed;
    totals.probe_pass_rate = passed / probes.length;
  }
  return totals;
}

export function buildReport(input: BuildReportInput): Report {
  const report: Report = {
    kind: input.kind,
    fixture: input.fixture,
    provider: input.provider,
    config_id: input.config_id,
    started_at: input.started_at,
    turns: input.turns,
    totals: computeTotals(input.turns, input.probes),
  };
  if (input.probes && input.probes.length > 0) report.probes = input.probes;
  if (input.stopped_reason) report.stopped_reason = input.stopped_reason;
  return report;
}

export const MILESTONE_TURNS = [25, 50, 100, 125] as const;

/** Input tokens at a given turn number (last row with that turn, so rolled-back retries resolve to the final attempt). */
export function inputTokensAtTurn(report: Report, turn: number): number | undefined {
  for (let i = report.turns.length - 1; i >= 0; i--) {
    const row = report.turns[i] as TurnRow;
    if (row.turn === turn) return row.input_tokens;
  }
  return undefined;
}

const int = (n: number): string => Math.round(n).toLocaleString("en-US");
const usd = (n: number): string => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const maybe = (n: number | undefined): string => (n === undefined ? "-" : int(n));

export function formatTurnLine(row: TurnRow): string {
  const ms = row.latency_ms >= 1000 ? `${(row.latency_ms / 1000).toFixed(1)}s` : `${Math.round(row.latency_ms)}ms`;
  return [
    `t${String(row.turn).padStart(3, "0")}`,
    `in ${int(row.input_tokens)}`,
    `out ${int(row.output_tokens)}`,
    `cached ${int(row.cached_input_tokens)}`,
    usd(row.cost_usd),
    ms,
    row.outcome,
  ].join("  ");
}

export function formatReport(report: Report): string {
  const t = report.totals;
  const lines = [
    `${report.kind} report: ${report.fixture} on ${report.provider} (config ${report.config_id}, started ${report.started_at})`,
  ];
  if (report.stopped_reason) lines.push(`stopped early: ${report.stopped_reason}`);
  lines.push(
    `turns ${t.turns}, model calls ${t.calls}`,
    `cumulative input tokens ${int(t.input_tokens)} (cached ${int(t.cached_input_tokens)}), output ${int(t.output_tokens)}`,
    `cost ${usd(t.cost_usd)}, total latency ${(t.latency_ms / 1000).toFixed(1)}s`,
    `input tokens per turn: avg ${int(t.avg_input_tokens)}, p50 ${int(t.p50_input_tokens)}, p95 ${int(t.p95_input_tokens)}`,
    `input tokens at turn: ${MILESTONE_TURNS.map((m) => `${m}=${maybe(inputTokensAtTurn(report, m))}`).join("  ")}`,
    `repair rate ${pct(t.repair_rate)}, interlude rate ${pct(t.interlude_rate)}, rollback rate ${pct(t.rollback_rate)}`,
  );
  if (t.attention_misses !== undefined) lines.push(`attention misses ${t.attention_misses}`);
  if (t.probes_total !== undefined) {
    lines.push(`probes ${t.probes_passed}/${t.probes_total} passed (${pct(t.probe_pass_rate ?? 0)})`);
    for (const p of report.probes ?? []) {
      lines.push(`  ${p.passed ? "pass" : "FAIL"}  after turn ${p.after_turn}: ${p.question}`);
    }
  }
  return lines.join("\n");
}

export interface Comparison {
  a: Report;
  b: Report;
  cumulative_input: { a: number; b: number; ratio: number | null };
  cumulative_output: { a: number; b: number; ratio: number | null };
  cost: { a: number; b: number; ratio: number | null };
  avg_input: { a: number; b: number; ratio: number | null };
  p50_input: { a: number; b: number; ratio: number | null };
  p95_input: { a: number; b: number; ratio: number | null };
  at_turn: { turn: number; a: number | undefined; b: number | undefined; ratio: number | null }[];
}

function pair(a: number, b: number): { a: number; b: number; ratio: number | null } {
  return { a, b, ratio: a === 0 ? null : b / a };
}

/** Ratios are b/a; callers put the reference (baseline) first. */
export function compareReports(a: Report, b: Report): Comparison {
  return {
    a,
    b,
    cumulative_input: pair(a.totals.input_tokens, b.totals.input_tokens),
    cumulative_output: pair(a.totals.output_tokens, b.totals.output_tokens),
    cost: pair(a.totals.cost_usd, b.totals.cost_usd),
    avg_input: pair(a.totals.avg_input_tokens, b.totals.avg_input_tokens),
    p50_input: pair(a.totals.p50_input_tokens, b.totals.p50_input_tokens),
    p95_input: pair(a.totals.p95_input_tokens, b.totals.p95_input_tokens),
    at_turn: MILESTONE_TURNS.map((turn) => {
      const x = inputTokensAtTurn(a, turn);
      const y = inputTokensAtTurn(b, turn);
      return { turn, a: x, b: y, ratio: x === undefined || y === undefined || x === 0 ? null : y / x };
    }),
  };
}

const ratioText = (r: number | null): string => (r === null ? "-" : `${r.toFixed(2)}x`);

export function formatComparison(c: Comparison): string {
  const la = `${c.a.kind}/${c.a.provider}`;
  const lb = `${c.b.kind}/${c.b.provider}`;
  const w = 16;
  const row = (label: string, x: string, y: string, r: string): string =>
    `${label.padEnd(28)}${x.padStart(w)}${y.padStart(w)}${r.padStart(10)}`;
  const ta = c.a.totals;
  const tb = c.b.totals;
  const lines = [
    `comparison: ${c.a.fixture} (${la}) vs ${c.b.fixture} (${lb})`,
    row("", la, lb, "b/a"),
    row("turns", String(ta.turns), String(tb.turns), ""),
    row("cumulative input tokens", int(c.cumulative_input.a), int(c.cumulative_input.b), ratioText(c.cumulative_input.ratio)),
    row("cumulative output tokens", int(c.cumulative_output.a), int(c.cumulative_output.b), ratioText(c.cumulative_output.ratio)),
    row("cached input tokens", int(ta.cached_input_tokens), int(tb.cached_input_tokens), ""),
    row("cost", usd(c.cost.a), usd(c.cost.b), ratioText(c.cost.ratio)),
    row("avg input/turn", int(c.avg_input.a), int(c.avg_input.b), ratioText(c.avg_input.ratio)),
    row("p50 input/turn", int(c.p50_input.a), int(c.p50_input.b), ratioText(c.p50_input.ratio)),
    row("p95 input/turn", int(c.p95_input.a), int(c.p95_input.b), ratioText(c.p95_input.ratio)),
    ...c.at_turn.map((m) => row(`input at turn ${m.turn}`, maybe(m.a), maybe(m.b), ratioText(m.ratio))),
    row("repair rate", pct(ta.repair_rate), pct(tb.repair_rate), ""),
    row("interlude rate", pct(ta.interlude_rate), pct(tb.interlude_rate), ""),
    row("rollback rate", pct(ta.rollback_rate), pct(tb.rollback_rate), ""),
    row("attention misses", maybe(ta.attention_misses), maybe(tb.attention_misses), ""),
    row(
      "probe pass rate",
      ta.probe_pass_rate === undefined ? "-" : pct(ta.probe_pass_rate),
      tb.probe_pass_rate === undefined ? "-" : pct(tb.probe_pass_rate),
      "",
    ),
  ];
  return lines.join("\n");
}

export function parseReport(json: unknown, source = "report"): Report {
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${source} is not a valid report: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`);
  }
  return parsed.data;
}
