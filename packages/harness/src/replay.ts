import type { Config, LLMProvider, Store } from "@book/schema";
import type { Fixture, Probe } from "./fixture.ts";
import { dueProbes, scoreProbe } from "./fixture.ts";
import { buildReport, formatTurnLine } from "./report.ts";
import type { ProbeResult, Report, TurnRow } from "./report.ts";
import type { RunControl } from "./run-common.ts";
import { stopReasonFor } from "./run-common.ts";
import type { RuntimeApi, TurnResultLike } from "./runtime-api.ts";

export interface ReplayOptions extends RunControl {
  api: RuntimeApi;
  config: Config;
  store: Store;
  llm: LLMProvider;
  fixture: Fixture;
  probes?: Probe[];
  saveId: string;
  providerName: string;
  deltaFirst?: boolean;
  now?: () => Date;
}

const ATTENTION_PURPOSE = /attention|need/i;

/** `inputTurn` is the fixture turn number, so engine and baseline rows line up; the game's own counter goes in `game_turn`. */
export function rowFromResult(result: TurnResultLike, inputTurn: number, wallMs: number, withParts = true): TurnRow {
  const usage = result.record.usage;
  const sum = (pick: (u: (typeof usage)[number]) => number): number => usage.reduce((n, u) => n + pick(u), 0);
  const misses = usage.filter((u) => ATTENTION_PURPOSE.test(u.purpose)).length;
  const story = usage.find((u) => u.purpose === "turn") ?? usage[0];
  const row: TurnRow = {
    turn: inputTurn,
    game_turn: result.turn,
    input_tokens: sum((u) => u.input_tokens),
    output_tokens: sum((u) => u.output_tokens),
    ...(story ? { story_output_tokens: story.output_tokens } : {}),
    cached_input_tokens: sum((u) => u.cached_input_tokens),
    cost_usd: sum((u) => u.cost_usd),
    latency_ms: wallMs,
    outcome: result.outcome,
    calls: usage.length,
    interlude: result.interlude !== undefined,
  };
  if (misses > 0) row.attention_misses = misses;
  if (withParts && result.record.context_parts.length > 0) row.context_parts = result.record.context_parts;
  return row;
}

export async function runReplay(opts: ReplayOptions): Promise<Report> {
  const now = opts.now ?? (() => new Date());
  const started_at = now().toISOString();
  const rt = opts.api.createRuntime({
    config: opts.config,
    store: opts.store,
    llm: opts.llm,
    ...(opts.deltaFirst ? { deltaFirst: true } : {}),
  });
  await opts.api.newGame(rt, opts.saveId);

  const rows: TurnRow[] = [];
  const probeResults: ProbeResult[] = [];
  const asked = new Set<Probe>();
  let stopped: string | undefined;

  const inputs = opts.maxTurns === undefined ? opts.fixture.inputs : opts.fixture.inputs.slice(0, opts.maxTurns);
  if (opts.maxTurns !== undefined && opts.maxTurns < opts.fixture.inputs.length) {
    stopped = `max-turns ${opts.maxTurns} reached`;
  }

  outer: for (const input of inputs) {
    const reason = opts.stopCheck?.();
    if (reason) {
      stopped = reason;
      break;
    }
    const t0 = performance.now();
    try {
      const result = await opts.api.playTurn(rt, opts.saveId, input.text);
      const row = rowFromResult(result, input.turn, Math.round(performance.now() - t0));
      rows.push(row);
      opts.onLine?.(formatTurnLine(row));
    } catch (err) {
      const why = stopReasonFor(err);
      if (why === undefined) throw err;
      stopped = why;
      break;
    }

    for (const probe of dueProbes(opts.probes ?? [], asked, input.turn)) {
      asked.add(probe);
      try {
        const res = await opts.api.playTurn(rt, opts.saveId, `OOC: ${probe.question}`);
        const row = rowFromResult(res, input.turn, 0, false);
        const passed = scoreProbe(res.narration, probe.expect_any);
        probeResults.push({
          after_turn: probe.after_turn,
          question: probe.question,
          passed,
          answer: res.narration,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          cost_usd: row.cost_usd,
        });
        opts.onLine?.(`probe @${probe.after_turn}  ${passed ? "pass" : "FAIL"}  ${probe.question}`);
      } catch (err) {
        const why = stopReasonFor(err);
        if (why === undefined) throw err;
        stopped = why;
        break outer;
      }
    }
  }

  return buildReport({
    kind: "engine",
    fixture: opts.fixture.id,
    provider: opts.providerName,
    config_id: opts.config.id,
    started_at,
    turns: rows,
    probes: probeResults,
    ...(stopped ? { stopped_reason: stopped } : {}),
  });
}
