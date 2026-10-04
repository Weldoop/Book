import { diffMinutes } from "@book/engine";
import type { Config, DueItem, Entity, Module, State, Thread } from "@book/schema";
import { DEFAULT_FOCUS_LIMIT } from "./budget.ts";
import { wordMatcher } from "./text.ts";

export interface AttentionArgs {
  config: Config;
  state: State;
  modules: Module[];
  input: string;
  due: DueItem[];
  limit?: number;
}

export const DUE_THREADS_FOR_ATTENTION = 4;

/** Importance plus a recency bonus; higher is warmer. */
export function decayScore(entity: Entity, turn: number): number {
  const importance = entity.facts.reduce((m, f) => Math.max(m, f.importance), 0);
  const age = Math.max(0, turn - entity.last_touched);
  return importance + 3 / (1 + age);
}

/** Open threads ordered for display: dated first (soonest), then warm, then cold. */
export function orderThreads(threads: Thread[]): Thread[] {
  const open = threads.filter((t) => t.status === "open");
  const rank = (t: Thread): number => (t.due ? 0 : t.warm ? 1 : 2);
  return open.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const d = (a.due ?? "").localeCompare(b.due ?? "");
      if (d !== 0) return d;
      return a.opened_turn - b.opened_turn || a.id.localeCompare(b.id);
    }
    return b.opened_turn - a.opened_turn || a.id.localeCompare(b.id);
  });
}

/**
 * Picks the few threads worth prompt space. The stored pool is unlimited; a thread earns a place by
 * having a deadline in view, by involving someone on screen, or by still having reminders left.
 * A cold thread stays in state and bites later through `overdueThreads`.
 */
export function selectThreads(state: State, config: Config, focusIds: string[] = []): Thread[] {
  const now = state.clock.now;
  const window = config.threads.rewarm_hours * 60;
  const onScreen = new Set(focusIds);
  const near = (t: Thread): boolean => t.due !== undefined && diffMinutes(t.due, now) <= window;
  const inFocus = (t: Thread): boolean => t.entities.some((id) => onScreen.has(id));

  const rank = (t: Thread): number => (near(t) ? 0 : inFocus(t) ? 1 : 2);
  const eligible = state.threads.filter((t) => t.status === "open" && (t.warm || near(t) || inFocus(t)));

  return eligible
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
      if (a.due !== b.due) return a.due ? -1 : 1;
      return b.opened_turn - a.opened_turn || a.id.localeCompare(b.id);
    })
    .slice(0, config.threads.max_in_context);
}

function mentioned(entity: Entity, input: string): boolean {
  for (const term of [entity.name, ...entity.aliases]) {
    const re = wordMatcher(term);
    if (re?.test(input)) return true;
  }
  return false;
}

/** Ordered entity ids for FOCUS ENTITIES (docs/ARCHITECTURE.md section 6.1). */
export function mapAttention(args: AttentionArgs): string[] {
  const { config, state, modules, input, due } = args;
  const limit = args.limit ?? DEFAULT_FOCUS_LIMIT;
  const out: string[] = [];
  const seen = new Set<string>();

  const eligible = (id: string): boolean => {
    const e = state.entities[id];
    if (!e || id === config.player_id) return false;
    return !(e.type === "place" && e.facts.length === 0);
  };
  const add = (ids: Iterable<string>): void => {
    for (const id of ids) {
      if (seen.has(id) || !eligible(id)) continue;
      seen.add(id);
      out.push(id);
    }
  };
  const byScore = (ids: string[]): string[] =>
    [...ids].sort((a, b) => {
      const ea = state.entities[a];
      const eb = state.entities[b];
      const sa = ea ? decayScore(ea, state.turn) : 0;
      const sb = eb ? decayScore(eb, state.turn) : 0;
      return sb - sa || a.localeCompare(b);
    });

  const locationId = state.entities[config.player_id]?.location ?? null;
  const here = locationId
    ? Object.values(state.entities)
        .filter((e) => e.location === locationId)
        .map((e) => e.id)
    : [];

  // What the player names and what is firing now outrank bystanders, so a crowded
  // location cannot push them out of the limit.
  if (locationId) add([locationId]);
  add(
    byScore(
      Object.values(state.entities)
        .filter((e) => mentioned(e, input))
        .map((e) => e.id),
    ),
  );
  for (const item of due) add(item.entities);
  add(byScore(here));

  const hot = orderThreads(state.threads)
    .filter((t) => t.due)
    .slice(0, DUE_THREADS_FOR_ATTENTION);
  for (const t of hot) add(t.entities);

  add(state.focus_next);

  for (const m of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
    add(m.focus(state, input, config));
  }

  add(byScore(Object.keys(state.entities)));

  return out.slice(0, limit);
}
