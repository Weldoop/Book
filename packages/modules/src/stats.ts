import { humanTime } from "@book/engine";
import type { Config, Module, Op, State, StatDef, Violation } from "@book/schema";

/** One currency movement, dated by the clock it happened at. */
export interface LedgerEntry {
  clock: string;
  key: string;
  amount: number;
  reason: string;
}

export interface StatsState {
  values: Record<string, number>;
  /** The most recent currency movements, so "what did I spend on Saturday" has an answer the GM cannot invent. */
  ledger?: LedgerEntry[];
}

/** Lines kept and shown. Each is about a dozen tokens; summaries lose figures, this does not. */
export const LEDGER_CAP = 10;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function statsOf(state: State): StatsState {
  return (state.modules.stats as StatsState | undefined) ?? { values: {} };
}

export function statDef(config: Config, key: string): StatDef | undefined {
  return config.stats.find((s) => s.key === key);
}

export function floorOf(def: StatDef): number | undefined {
  if (def.min !== undefined) return def.min;
  return def.type === "currency" ? 0 : undefined;
}

export function formatStat(def: StatDef, value: number): string {
  if (def.type === "currency") {
    const display = def.display ?? "";
    if (display === "GBP" || display === "£") return `£${value.toFixed(2)}`;
    if (display === "" || !/[A-Za-z]/.test(display)) return `${display}${value.toFixed(2)}`;
    return `${value.toFixed(2)} ${display}`;
  }
  if (def.type === "bounded" && def.max !== undefined) return `${Math.round(value)}/${def.max}`;
  return String(Math.round(value * 100) / 100);
}

/** The label the model sees, with the id beside it when the two differ. */
function shownStat(def: StatDef): string {
  const label = def.label ?? def.key;
  return label === def.key ? label : `${label} [${def.key}]`;
}

function clamp(def: StatDef, value: number): number {
  let v = value;
  if (def.type === "bounded") {
    if (def.min !== undefined) v = Math.max(def.min, v);
    if (def.max !== undefined) v = Math.min(def.max, v);
  } else {
    if (def.max !== undefined) v = Math.min(def.max, v);
  }
  return round2(v);
}

/** "Money so far: Sat 3 Oct 11:15 -£2.50 cash milk and bread; Mon 5 Oct 21:00 +£40.00 cash shift wages". */
export function ledgerLines(stats: StatsState, config: Config): string {
  const entries = (stats.ledger ?? []).slice(-LEDGER_CAP);
  if (entries.length === 0) return "";
  const parts = entries.map((entry) => {
    const def = statDef(config, entry.key);
    const amount = def ? formatStat(def, Math.abs(entry.amount)) : String(Math.abs(entry.amount));
    const key = def && (def.label ?? def.key) !== "" ? ` ${(def.label ?? def.key).toLowerCase()}` : "";
    const reason = entry.reason ? ` ${entry.reason}` : "";
    const when = humanTime(entry.clock).replace(/ \d{4},/, "");
    return `${when} ${entry.amount < 0 ? "-" : "+"}${amount}${key}${reason}`;
  });
  return `Money so far: ${parts.join("; ")}`;
}

export const statsModule: Module = {
  id: "stats",
  ops: ["stat.add", "stat.set"],

  initState(config) {
    const values: Record<string, number> = {};
    for (const def of config.stats) values[def.key] = def.start;
    return { values } satisfies StatsState;
  },

  validateOp(op: Op, index: number, state: State, config: Config): Violation[] {
    if (op.op !== "stat.add" && op.op !== "stat.set") return [];
    const def = statDef(config, op.key);
    if (!def) {
      return [
        {
          severity: "fixable",
          code: "unknown_stat",
          op_index: index,
          message: `Op ${index}: stat '${op.key}' does not exist. Known stats: ${config.stats.map((s) => s.key).join(", ")}.`,
        },
      ];
    }
    const current = statsOf(state).values[op.key] ?? def.start;
    const next = op.op === "stat.add" ? current + op.amount : op.value;
    const floor = floorOf(def);
    if (def.type === "currency" && floor !== undefined && next < floor) {
      return [
        {
          severity: "game_breaking",
          code: "insufficient_funds",
          op_index: index,
          message: `Op ${index}: ${def.label ?? def.key} would drop to ${formatStat(def, next)} but the player only has ${formatStat(def, current)}. The player cannot afford this.`,
        },
      ];
    }
    return [];
  },

  applyOp(op: Op, state: State, config: Config): State {
    if (op.op !== "stat.add" && op.op !== "stat.set") return state;
    const def = statDef(config, op.key);
    if (!def) return state;
    const s = structuredClone(state);
    const stats = (s.modules.stats as StatsState | undefined) ?? { values: {} };
    const current = stats.values[op.key] ?? def.start;
    stats.values[op.key] = clamp(def, op.op === "stat.add" ? current + op.amount : op.value);
    if (def.type === "currency" && op.op === "stat.add" && op.amount !== 0) {
      const ledger = stats.ledger ?? [];
      ledger.push({ clock: s.clock.now, key: op.key, amount: round2(op.amount), reason: (op.reason ?? "").trim() });
      stats.ledger = ledger.slice(-LEDGER_CAP);
    }
    s.modules.stats = stats;
    return s;
  },

  promptFragment: () =>
    "STATS: stat.add with a negative amount spends; give a short reason. A currency never goes below zero: if they cannot afford one unit, narrate that and take nothing.",

  focus: () => [],

  due: () => [],

  snapshot(state, config) {
    const stats = statsOf(state);
    const parts = config.stats.map((def) => `${shownStat(def)}: ${formatStat(def, stats.values[def.key] ?? def.start)}`);
    const lines = parts.length ? [`Stats: ${parts.join(" | ")}`] : [];
    const ledger = ledgerLines(stats, config);
    if (ledger) lines.push(ledger);
    return lines;
  },

  truth(state, config) {
    const values = statsOf(state).values;
    const parts: string[] = [];
    for (const key of config.presentation.status_line) {
      const def = statDef(config, key);
      if (!def || def.hidden) continue;
      parts.push(`${def.label ?? def.key}: ${formatStat(def, values[def.key] ?? def.start)}`);
    }
    return parts.length ? [parts.join(" | ")] : [];
  },

  render(state, config) {
    const values = statsOf(state).values;
    const panel = config.stats
      .filter((def) => !def.hidden)
      .map((def) => `${def.label ?? def.key}: ${formatStat(def, values[def.key] ?? def.start)}`);
    return { panel };
  },
};
