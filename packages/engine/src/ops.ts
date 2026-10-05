import { OpSchema, type Config, type Module, type Op, type State, type Violation } from "@book/schema";
import { resolveStatKey } from "./stat-key.ts";

export interface ProcessedOps {
  state: State;
  applied: Op[];
  violations: Violation[];
  /** Minutes from clock.advance only; clock.skip is capped separately and excluded. */
  minutes: number;
  skipped: number;
}

function ownerOf(modules: Module[], op: Op): Module | undefined {
  return modules.find((m) => m.ops.includes(op.op));
}

/** "Gold" never reaches the stats module: the id schema rejects it first. Map it here. */
function canonicalizeRaw(config: Config, raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const row = raw as Record<string, unknown>;
  if ((row.op !== "stat.add" && row.op !== "stat.set") || typeof row.key !== "string") return raw;
  const key = resolveStatKey(config, row.key);
  return key ? { ...row, key } : raw;
}

/**
 * Validates and applies ops in order, so later ops see the effects of earlier ones
 * (for example `entity.create` followed by `entity.fact.add`). Ops that produce violations are not applied.
 */
export function processOps(state: State, config: Config, modules: Module[], rawOps: unknown[]): ProcessedOps {
  const violations: Violation[] = [];
  const applied: Op[] = [];
  let current = state;
  let minutes = 0;
  let skipped = 0;

  rawOps.forEach((raw, index) => {
    const parsed = OpSchema.safeParse(canonicalizeRaw(config, raw));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const name = typeof raw === "object" && raw !== null && "op" in raw ? String((raw as { op: unknown }).op) : "?";
      violations.push({
        severity: "fixable",
        code: "bad_op",
        op_index: index,
        message: `Op ${index} (${name}) is malformed: ${issue?.path.join(".") || "op"}: ${issue?.message ?? "invalid"}`,
      });
      return;
    }
    const op = parsed.data;
    const owner = ownerOf(modules, op);
    if (!owner) {
      violations.push({
        severity: "fixable",
        code: "inactive_op",
        op_index: index,
        message: `Op ${index} (${op.op}) belongs to a module that is not active in this game.`,
      });
      return;
    }
    const found = owner.validateOp(op, index, current, config);
    if (found.length > 0) {
      violations.push(...found);
      return;
    }
    if (op.op === "clock.advance") minutes += op.minutes;
    if (op.op === "clock.skip") skipped += op.minutes;
    current = owner.applyOp(op, current, config);
    applied.push(op);
  });

  if (minutes > config.time.max_per_turn) {
    const cap = config.time.max_skip_minutes;
    const asSkip = cap > 0 && minutes <= cap;
    violations.push({
      severity: asSkip ? "fixable" : "game_breaking",
      code: "time_jump",
      message: asSkip
        ? `Total time advanced this turn (${minutes} minutes) is longer than one scene (${config.time.max_per_turn} minutes). Use clock.skip with a reason instead, at most ${cap} minutes, and keep the move.`
        : `Total time advanced this turn (${minutes} minutes) exceeds the limit of ${config.time.max_per_turn} minutes. Shorten the scene or end it earlier.`,
    });
  }

  return { state: current, applied, violations, minutes, skipped };
}
