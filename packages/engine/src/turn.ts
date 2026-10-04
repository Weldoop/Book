import {
  TurnDraftSchema,
  type Config,
  type DueItem,
  type Module,
  type State,
  type TurnDraft,
  type TurnKind,
  type Violation,
} from "@book/schema";
import { processOps } from "./ops.ts";
import { rngFor } from "./rng.ts";
import { addMinutes } from "./time.ts";

const WINDOW_CAP = 12;
const BEATS_CAP = 60;

export function classifyInput(input: string): TurnKind {
  const text = input.trim();
  if (text === "" || /^(\.{2,}|…)+$/.test(text)) return "continue";
  if (/^ooc\b/i.test(text)) return "ooc";
  if (/^\(.*\)$/s.test(text)) return "ooc";
  if (/^(dm|gm)[?!. ]*$/i.test(text)) return "ooc";
  return "act";
}

export function stripOocPrefix(input: string): string {
  return input
    .trim()
    .replace(/^ooc\b[:\s-]*/i, "")
    .replace(/^\((.*)\)$/s, "$1")
    .trim();
}

export function collectDue(state: State, config: Config, modules: Module[]): DueItem[] {
  const rng = rngFor(state.rng_seed, state.turn + 1, "due");
  const now = state.clock.now;
  return modules.flatMap((m) => m.due(state, config, now, now, rng));
}

/** Draws the single fate die for this turn. Deterministic per save and turn. */
export function rollFate(state: State, config: Config): number | undefined {
  if (!config.dice) return undefined;
  const rng = rngFor(state.rng_seed, state.turn + 1, "fate");
  return 1 + Math.floor(rng.next() * config.dice.sides);
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
  warnings: string[];
}

export function severityOf(violations: Violation[]): "none" | "fixable" | "game_breaking" {
  if (violations.length === 0) return "none";
  return violations.some((v) => v.severity === "game_breaking") ? "game_breaking" : "fixable";
}

export function validateDraft(state: State, config: Config, modules: Module[], draft: TurnDraft): ValidationResult {
  const { violations } = processOps(state, config, modules, draft.delta);
  const warnings: string[] = [];
  const words = draft.narration.trim().split(/\s+/).length;
  if (words > config.gm_style.max_words * 2) {
    warnings.push(`narration has ${words} words (limit ${config.gm_style.max_words})`);
  }
  return { ok: violations.length === 0, violations, warnings };
}

export function parseDraft(value: unknown): { ok: true; draft: TurnDraft } | { ok: false; error: string } {
  const parsed = TurnDraftSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "draft"}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, draft: parsed.data };
}

export interface ApplyContext {
  input: string;
  due: DueItem[];
}

/** Applies a draft that has already passed validation. Pure: returns the next state. */
export function applyDraft(state: State, config: Config, modules: Module[], draft: TurnDraft, ctx: ApplyContext): State {
  const processed = processOps(state, config, modules, draft.delta);
  if (processed.violations.length > 0) {
    throw new Error("applyDraft called with a draft that fails validation");
  }
  let next = processed.state;
  const turn = state.turn + 1;

  if (processed.minutes < config.time.min_per_action) {
    next = { ...next, clock: { now: addMinutes(next.clock.now, config.time.min_per_action - processed.minutes) } };
  }

  next = structuredClone(next);
  for (const item of ctx.due) {
    if (item.thread) {
      next.threads.push({
        id: `t${next.threads.length + 1}`,
        kind: item.thread.kind,
        text: item.thread.text,
        status: "open",
        entities: item.entities.filter((id) => next.entities[id]),
        warm: true,
        opened_turn: turn,
      });
    }
  }

  const clockBefore = state.clock.now;
  for (const m of modules) {
    if (m.onTurnCommitted) next = m.onTurnCommitted(next, config, { due: ctx.due, now: clockBefore });
  }

  next.turn = turn;
  next.beats.push({ turn, text: draft.beat });
  if (next.beats.length > BEATS_CAP) next.beats = next.beats.slice(-BEATS_CAP);
  next.window.push({ turn, input: ctx.input, narration: draft.narration, clock: next.clock.now });
  if (next.window.length > WINDOW_CAP) next.window = next.window.slice(-WINDOW_CAP);
  next.focus_next = (draft.focus_next ?? []).filter((id) => next.entities[id]).slice(0, 8);
  return next;
}

export function pickInterlude(state: State, config: Config): string {
  const rng = rngFor(state.rng_seed, state.turn + 1, "interlude");
  const list = config.gm_style.interludes;
  return list[Math.floor(rng.next() * list.length)] ?? list[0] ?? "";
}
