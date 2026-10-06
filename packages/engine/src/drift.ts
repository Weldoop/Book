import type { Config, State } from "@book/schema";
import type { ProcessedOps } from "./ops.ts";

interface StatsBag {
  values: Record<string, number>;
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let v = value;
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return Math.round(v * 100) / 100;
}

/**
 * A bounded stat with `per_hour` moves with the clock: energy drains over hours awake and comes
 * back over hours of `clock.skip` at `per_skip_hour`. A turn where the GM already credited the stat
 * was rest, so it is not drained as well. A clock set to an exact time carries no elapsed hours.
 */
export function driftStats(state: State, config: Config, processed: Pick<ProcessedOps, "minutes" | "skipped" | "anchored" | "applied">): void {
  if (processed.anchored) return;
  const bag = state.modules.stats as StatsBag | undefined;
  if (!bag?.values) return;
  for (const def of config.stats) {
    if (def.type !== "bounded" || (def.per_hour === undefined && def.per_skip_hour === undefined)) continue;
    const credited = processed.applied.some((op) => op.op === "stat.add" && op.key === def.key && op.amount > 0);
    let change = 0;
    if (def.per_hour !== undefined && !credited) change += (def.per_hour * processed.minutes) / 60;
    if (def.per_skip_hour !== undefined) change += (def.per_skip_hour * processed.skipped) / 60;
    if (change === 0) continue;
    const current = bag.values[def.key] ?? def.start;
    bag.values[def.key] = clamp(current + change, def.min, def.max);
  }
}
