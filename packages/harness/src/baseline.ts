import type { Config, LLMProvider, LLMRequest } from "@book/schema";
import type { Fixture, Probe } from "./fixture.ts";
import { dueProbes, scoreProbe } from "./fixture.ts";
import { buildReport, formatTurnLine } from "./report.ts";
import type { ProbeResult, Report, TurnRow } from "./report.ts";
import type { RunControl } from "./run-common.ts";
import { stopReasonFor } from "./run-common.ts";

export interface BaselineOptions extends RunControl {
  config: Config;
  llm: LLMProvider;
  fixture: Fixture;
  probes?: Probe[];
  providerName: string;
  now?: () => Date;
}

export function baselineSystem(config: Config): string {
  const gm = config.gm_style;
  const person = gm.person === "second" ? "second person" : `${gm.person} person`;
  const lines = [
    `You are the game master of an interactive story: ${config.meta.title}.`,
    `Tone: ${config.meta.tone}`,
  ];
  if (config.meta.premise) lines.push(`Premise: ${config.meta.premise}`);
  lines.push(
    `Rules: reply in 50-90 words, in ${person}. Never decide actions for the player. Keep track of time, money and health yourself. End every reply with a one-line status: money | health | place | time.`,
  );
  return lines.join("\n");
}

const BASELINE_MAX_TOKENS = 400;

export async function runBaseline(opts: BaselineOptions): Promise<Report> {
  const now = opts.now ?? (() => new Date());
  const started_at = now().toISOString();
  const system = [{ text: baselineSystem(opts.config) }];
  const history: LLMRequest["messages"] = [];
  const rows: TurnRow[] = [];
  const probeResults: ProbeResult[] = [];
  const asked = new Set<Probe>();
  let stopped: string | undefined;

  const ask = (messages: LLMRequest["messages"]): Promise<Awaited<ReturnType<LLMProvider["complete"]>>> =>
    opts.llm.complete({
      tier: "strong",
      system,
      messages,
      max_tokens: BASELINE_MAX_TOKENS,
      purpose: "baseline_turn",
    });

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
      const messages: LLMRequest["messages"] = [...history, { role: "user", content: input.text }];
      const res = await ask(messages);
      history.push({ role: "user", content: input.text }, { role: "assistant", content: res.text });
      const row: TurnRow = {
        turn: input.turn,
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        story_output_tokens: res.usage.output_tokens,
        cached_input_tokens: res.usage.cached_input_tokens,
        cost_usd: res.usage.cost_usd,
        latency_ms: Math.round(performance.now() - t0),
        outcome: "ok",
        calls: 1,
      };
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
        const res = await ask([...history, { role: "user", content: probe.question }]);
        const passed = scoreProbe(res.text, probe.expect_any);
        probeResults.push({
          after_turn: probe.after_turn,
          question: probe.question,
          passed,
          answer: res.text,
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          cost_usd: res.usage.cost_usd,
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
    kind: "baseline",
    fixture: opts.fixture.id,
    provider: opts.providerName,
    config_id: opts.config.id,
    started_at,
    turns: rows,
    probes: probeResults,
    ...(stopped ? { stopped_reason: stopped } : {}),
  });
}
