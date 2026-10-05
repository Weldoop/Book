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
 * A person who is here, or a place the player is standing in. Naming them in the input counts too.
 * The player's own id never makes a thread relevant.
 */
function inScene(state: State, config: Config, input: string, id: string): { present: boolean; named: boolean } {
  const entity = state.entities[id];
  if (!entity || id === config.player_id) return { present: false, named: false };
  const here = state.entities[config.player_id]?.location ?? null;
  const named = mentioned(entity, input);
  const present =
    entity.type === "place" ? here === entity.id : here !== null && entity.location === here;
  return { present, named };
}

/**
 * Picks the few threads worth prompt space. An offer is never listed again after the turn it was
 * made. A minor or major is listed when its deadline is close, when the player just named someone
 * or some place on it, or when one of those is in the scene and the thread is still warm.
 * Majors take the first slots, up to `max_majors`. The rest of the budget goes to minors.
 */
export function selectThreads(state: State, config: Config, input = ""): Thread[] {
  const now = state.clock.now;
  const window = config.threads.rewarm_hours * 60;
  const near = (t: Thread): boolean => t.due !== undefined && diffMinutes(t.due, now) <= window;
  const qualifies = (t: Thread): boolean => {
    if (t.status !== "open" || t.scale === "potential") return false;
    if (near(t)) return true;
    let present = false;
    let named = false;
    for (const id of t.entities) {
      const hit = inScene(state, config, input, id);
      present = present || hit.present;
      named = named || hit.named;
    }
    if (named) return true;
    return present && t.warm;
  };

  const rank = (t: Thread): number => (near(t) ? 0 : 1);
  const sortThreads = (threads: Thread[]): Thread[] =>
    threads.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
      if (a.due !== b.due) return a.due ? -1 : 1;
      return b.opened_turn - a.opened_turn || a.id.localeCompare(b.id);
    });

  const eligible = state.threads.filter(qualifies);
  const majors = sortThreads(eligible.filter((t) => t.scale === "major")).slice(0, config.threads.max_majors);
  const room = Math.max(0, config.threads.max_in_context - majors.length);
  const minors = sortThreads(eligible.filter((t) => t.scale !== "major")).slice(0, room);
  return [...majors, ...minors];
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
    if (e.tags.includes("unmet") && !mentioned(e, input)) return false;
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
