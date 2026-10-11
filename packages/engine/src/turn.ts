import {
  TurnDraftSchema,
  type Config,
  type DueItem,
  type Entity,
  type GmNote,
  type Module,
  type Op,
  type State,
  type TurnDraft,
  type TurnKind,
  type Violation,
} from "@book/schema";
import { catalogItems } from "./catalog.ts";
import { consistencyViolations, materializeAt } from "./consistency.ts";
import { driftStats } from "./drift.ts";
import { selectHighlights } from "./highlights.ts";
import { syncPresence } from "./core.ts";
import { forgetMemories } from "./memory.ts";
import { normalizeDraft } from "./normalize.ts";
import { processOps } from "./ops.ts";
import { resolveStatKey } from "./stat-key.ts";
import { duplicateOpenThread, sharedContentWords } from "./threads.ts";
import { rngFor } from "./rng.ts";
import { addMinutes, diffMinutes } from "./time.ts";

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

export const OVERDUE_PREFIX = "overdue:";

/**
 * Threads whose deadline has passed unresolved. This is what lets a thread leave the prompt
 * and still bite: the garden is forgotten for a hundred turns, then the inspection finds it.
 */
export function overdueThreads(state: State, config: Config): DueItem[] {
  return state.threads
    .filter((t) => t.status === "open" && t.scale !== "potential" && t.due !== undefined && diffMinutes(state.clock.now, t.due) >= 0)
    .map((t) => ({
      id: `${OVERDUE_PREFIX}${t.id}`,
      kind: "scheduled" as const,
      text:
        t.on_overdue ??
        `The deadline has passed on "${t.text}". If the story already settled it, thread.resolve ${t.id}. Otherwise play the consequences now.`,
      entities: t.entities.filter((id) => state.entities[id]),
    }));
}

export function collectDue(state: State, config: Config, modules: Module[]): DueItem[] {
  const rng = rngFor(state.rng_seed, state.turn + 1, "due");
  const now = state.clock.now;
  return [...modules.flatMap((m) => m.due(state, config, now, now, rng)), ...overdueThreads(state, config)];
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

/** Maps a label written in check.stat onto the real id. An unknown name is fixable. */
function checkStat(config: Config, draft: TurnDraft): Violation[] {
  const stat = draft.check?.stat;
  if (!stat) return [];
  const key = resolveStatKey(config, stat);
  if (!key) {
    const known = config.stats.map((s) => s.key).join(", ");
    return [
      {
        severity: "fixable",
        code: "unknown_stat",
        message: `check.stat '${stat}' is not a stat. Omit it, or use one of: ${known}.`,
      },
    ];
  }
  if (key !== stat && draft.check) draft.check.stat = key;
  return [];
}

export function validateDraft(
  state: State,
  config: Config,
  modules: Module[],
  draft: TurnDraft,
  input = "",
): ValidationResult {
  normalizeDraft(state, config, draft);
  materializeAt(state, config, draft);
  const processed = processOps(withThreadContact(state, config, input), config, modules, draft.delta);
  const warnings: string[] = [];
  const words = draft.narration.trim().split(/\s+/).length;
  if (words > config.gm_style.max_words * 2) {
    warnings.push(`narration has ${words} words (limit ${config.gm_style.max_words})`);
  }
  const violations = [...processed.violations, ...checkStat(config, draft)];
  if (processed.violations.length === 0) {
    violations.push(...consistencyViolations(state, processed.state, config, draft, input, processed.applied));
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
  /** Threads the prompt actually showed this turn. */
  shown_threads?: string[];
}

/**
 * Warm means the player dealt with the thread inside `rewarm_hours`. Showing it, or standing
 * in its place, does not spend that time. A deadline brings a thread back without making it warm.
 */
export function ageThreads(state: State, config: Config, shown: string[], turn: number): void {
  const window = config.threads.rewarm_hours * 60;
  const shownSet = new Set(shown);
  for (const t of state.threads) {
    if (t.status !== "open") continue;
    if (shownSet.has(t.id)) t.last_shown_turn = turn;
    t.warm = t.last_interacted_at !== undefined && diffMinutes(state.clock.now, t.last_interacted_at) < window;
  }
}

/** An offer nobody took up lapses. It does not become a punishment. Goods that arrived are not a miss. */
export function lapsePotentials(state: State, turn: number, config?: Config): void {
  const now = state.clock.now;
  for (const thread of state.threads) {
    if (thread.status !== "open" || thread.scale !== "potential" || thread.expires === undefined) continue;
    if (diffMinutes(now, thread.expires) < 0) continue;
    if (config && goodsArrived(state, config, thread)) continue;
    thread.status = "failed";
    thread.resolved_turn = turn;
  }
}

const NOTES_CAP = 12;

/**
 * Keeps the GM's private notes, drops the ones that have aged out, and truncates anything that grew
 * into prose. Expiry is the point: a note is for the next few turns, so anything with a longer life
 * has to be opened as a thread instead.
 */
export function collectNotes(state: State, config: Config, draft: TurnDraft, turn: number): GmNote[] {
  if (!config.notes.enabled) return [];
  const cutoff = turn - config.notes.ttl_turns;
  const kept = state.notes.filter((n) => n.turn > cutoff);
  const added = (draft.notes ?? [])
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ turn, text: text.slice(0, config.notes.max_chars) }));
  return [...kept, ...added].slice(-NOTES_CAP);
}

/**
 * Opens the next scene once the GM has closed the last one. Called before a turn is built, so the
 * scene the player is about to act in is the new one.
 */
export function openScene(state: State): State {
  if (!state.scene.closed) return state;
  return { ...state, scene: { index: state.scene.index + 1, started_turn: state.turn, closed: false } };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word match. Short labels are skipped so "a" does not touch every thread. */
function namesEntity(entity: Entity, input: string): boolean {
  if (input.trim().length === 0) return false;
  for (const term of [entity.name, ...entity.aliases]) {
    const t = term.trim();
    if (t.length < 2) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(t)}(?![\\p{L}\\p{N}_])`, "iu");
    if (re.test(input)) return true;
  }
  return false;
}

/**
 * The player dealt with a thread by naming someone or some place on it. Opening and adopting
 * count too. Standing in its place does not, and neither does someone merely sharing the room.
 */
export function noteThreadContact(state: State, config: Config, input: string, turn: number): void {
  for (const thread of state.threads) {
    if (thread.status !== "open") continue;
    let named = false;
    for (const id of thread.entities) {
      if (id === config.player_id) continue;
      const entity = state.entities[id];
      if (entity && namesEntity(entity, input)) named = true;
    }
    if (!named) continue;
    thread.last_interacted_turn = Math.max(thread.last_interacted_turn, turn);
    thread.last_interacted_at = state.clock.now;
  }
}

/**
 * Money changing hands for the matter a thread is about settles it: "Budget plan switch" closes
 * the mobile plan thread, and "Corner shop shift wages" closes the shift.
 */
export function settlePaidThreads(state: State, config: Config, applied: Op[], turn: number): void {
  const keys = new Set(config.stats.filter((stat) => stat.type === "currency").map((stat) => stat.key));
  for (const op of applied) {
    if (op.op !== "stat.add" || !keys.has(op.key) || op.amount === 0 || !op.reason) continue;
    for (const thread of state.threads) {
      if (thread.status !== "open" || sharedContentWords(op.reason, thread.text) < 2) continue;
      thread.status = "resolved";
      thread.resolved_turn = turn;
      thread.resolved_at = state.clock.now;
    }
  }
}

const PLACE_SKIP = new Set(["the", "and", "for", "with", "from", "your"]);

function labelWords(label: string): string[] {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !PLACE_SKIP.has(word));
}

function textHasWords(text: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const hay = text.toLowerCase();
  return words.every((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay));
}

function placeInThread(place: { id: string; name: string; aliases: string[] }, text: string): boolean {
  const labels = [place.name, ...place.aliases, place.id.replace(/[_-]/g, " ")];
  return labels.some((label) => textHasWords(text, labelWords(label)));
}

/** The player is holding an item this thread is about buying. */
function goodsArrived(state: State, config: Config, thread: { text: string }): boolean {
  const player = config.player_id;
  const inv = state.modules.inventory as { owners?: Record<string, Record<string, number>> } | undefined;
  const held = inv?.owners?.[player] ?? {};
  for (const item of catalogItems(config, state)) {
    if ((held[item.id] ?? 0) < 1) continue;
    if (sharedContentWords(`${item.name} ${item.id.replace(/[_-]/g, " ")}`, thread.text) >= 1) return true;
  }
  return false;
}

/**
 * Buying the thread's item at the thread's place keeps the meetup.
 * The same item bought somewhere else leaves the thread open.
 */
export function settlePurchasedThreads(state: State, config: Config, applied: Op[], turn: number): void {
  const player = config.player_id;
  const here = state.entities[player]?.location;
  const place = here ? state.entities[here] : undefined;
  if (!place || place.type !== "place") return;
  const catalog = catalogItems(config, state);
  for (const op of applied) {
    if (op.op !== "inventory.add" || op.owner !== player) continue;
    const item = catalog.find((row) => row.id === op.item);
    if (!item) continue;
    const itemText = `${item.name} ${item.id.replace(/[_-]/g, " ")}`;
    for (const thread of state.threads) {
      if (thread.status !== "open") continue;
      if (sharedContentWords(itemText, thread.text) < 1) continue;
      if (!placeInThread(place, thread.text)) continue;
      thread.status = "resolved";
      thread.resolved_turn = turn;
      thread.resolved_at = state.clock.now;
    }
  }
}

function withThreadContact(state: State, config: Config, input: string): State {
  const next = structuredClone(state);
  noteThreadContact(next, config, input, state.turn + 1);
  return next;
}

/** Applies a draft that has already passed validation. Pure: returns the next state. */
export function applyDraft(state: State, config: Config, modules: Module[], draft: TurnDraft, ctx: ApplyContext): State {
  normalizeDraft(state, config, draft);
  materializeAt(state, config, draft);
  const processed = processOps(withThreadContact(state, config, ctx.input), config, modules, draft.delta);
  if (processed.violations.length > 0) {
    throw new Error("applyDraft called with a draft that fails validation");
  }
  let next = processed.state;
  const turn = state.turn + 1;

  if (!processed.anchored && processed.skipped === 0 && processed.minutes < config.time.min_per_action) {
    next = { ...next, clock: { now: addMinutes(next.clock.now, config.time.min_per_action - processed.minutes) } };
  }

  next = structuredClone(next);
  driftStats(next, config, processed);
  settlePaidThreads(next, config, processed.applied, turn);
  settlePurchasedThreads(next, config, processed.applied, turn);
  for (const item of ctx.due) {
    if (item.thread && !duplicateOpenThread(next.threads, item.thread.text, undefined, next.clock.now)) {
      next.threads.push({
        id: `t${next.threads.length + 1}`,
        kind: item.thread.kind,
        text: item.thread.text,
        status: "open",
        entities: item.entities.filter((id) => next.entities[id]),
        scale: "minor",
        was_major: false,
        warm: true,
        reminders: 0,
        last_shown_turn: turn,
        last_interacted_turn: turn,
        last_interacted_at: next.clock.now,
        opened_turn: turn,
      });
    }
    // An overdue thread has now had its consequence narrated, so it stops asking for one.
    // One the GM resolved this turn was already settled, so it is not a failure.
    if (item.id.startsWith(OVERDUE_PREFIX)) {
      const t = next.threads.find((x) => x.id === item.id.slice(OVERDUE_PREFIX.length));
      if (t && t.status === "open") {
        t.status = "failed";
        t.resolved_turn = turn;
      }
    }
  }
  ageThreads(next, config, ctx.shown_threads ?? [], turn);
  forgetMemories(next);
  lapsePotentials(next, turn, config);

  const clockBefore = state.clock.now;
  for (const m of modules) {
    if (m.onTurnCommitted) next = m.onTurnCommitted(next, config, { due: ctx.due, now: clockBefore });
  }

  next.turn = turn;
  if (draft.scene_ended) {
    const title = draft.chapter_title?.trim();
    next.scene = { ...next.scene, closed: true, ...(title ? { title } : {}) };
  }
  next.notes = collectNotes(next, config, draft, turn);
  next.beats.push({ turn, text: draft.beat, clock: next.clock.now });
  if (next.beats.length > BEATS_CAP) next.beats = next.beats.slice(-BEATS_CAP);
  const highlights = selectHighlights(draft.narration, draft.highlights, next, config);
  next.window.push({
    turn,
    input: ctx.input,
    narration: draft.narration,
    clock: next.clock.now,
    ...(highlights.length > 0 ? { highlights } : {}),
  });
  if (next.window.length > WINDOW_CAP) next.window = next.window.slice(-WINDOW_CAP);
  next.focus_next = (draft.focus_next ?? []).filter((id) => next.entities[id]).slice(0, 8);
  return syncPresence(next, config);
}

/**
 * Warnings the engine prints itself, so a missed narration cannot hide them. An overdue thread is
 * named in the player's words, and one the turn resolved is not a warning.
 */
export function playerNotices(due: DueItem[], state?: State): string[] {
  const out: string[] = [];
  for (const d of due) {
    if (d.kind === "conditional") {
      out.push(d.text);
      continue;
    }
    if (!d.id.startsWith(OVERDUE_PREFIX)) continue;
    const thread = state?.threads.find((t) => t.id === d.id.slice(OVERDUE_PREFIX.length));
    if (thread?.status === "resolved") continue;
    out.push(thread ? `The deadline has passed on "${thread.text}".` : d.text);
  }
  return out;
}

export function pickInterlude(state: State, config: Config): string {
  const rng = rngFor(state.rng_seed, state.turn + 1, "interlude");
  const list = config.gm_style.interludes;
  return list[Math.floor(rng.next() * list.length)] ?? list[0] ?? "";
}
