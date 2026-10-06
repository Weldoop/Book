import { diffMinutes, parseLocal, shortTime } from "@book/engine";
import type { Condition, Config, DueItem, Module, State } from "@book/schema";
import { relationshipValue } from "./relationships.ts";
import { statsOf, statDef } from "./stats.ts";

export interface EventsState {
  fired: Record<string, string>;
  last_eval: string | null;
}

export function eventsOf(state: State): EventsState {
  return (state.modules.events as EventsState | undefined) ?? { fired: {}, last_eval: null };
}

type CmpOp = "<" | "<=" | ">" | ">=" | "==";

function compare(op: CmpOp, left: number, right: number): boolean {
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    default:
      return left === right;
  }
}

export function conditionHolds(cond: Condition, state: State, config: Config, now: string): boolean {
  switch (cond.kind) {
    case "stat": {
      const def = statDef(config, cond.key);
      const value = statsOf(state).values[cond.key] ?? def?.start ?? 0;
      return compare(cond.op, value, cond.value);
    }
    case "relationship":
      return compare(cond.op, relationshipValue(state, cond.a, cond.b), cond.value);
    case "after":
      return diffMinutes(now, cond.at) >= 0;
  }
}

const REFIRE_MINUTES = 24 * 60;
const MAX_ELAPSED_HOURS = 8;

export const eventsModule: Module = {
  id: "events",
  ops: [],

  initState: () => ({ fired: {}, last_eval: null }) satisfies EventsState,

  validateOp: () => [],
  applyOp: (_op, state) => state,

  promptFragment: () =>
    "EVENTS: Items in DUE EVENTS are real things that happen now or have just happened while time passed. Weave every one into the narration naturally (do not skip or contradict them). Anything in UPCOMING is scheduled in the world; mention it only if the player would plausibly notice or ask.",

  focus: () => [],

  due(state, config, _from, to, rng) {
    const ev = eventsOf(state);
    const items: DueItem[] = [];

    for (const e of config.events.scheduled) {
      if (ev.fired[e.id]) continue;
      if (diffMinutes(to, e.at) >= 0) {
        const late = diffMinutes(to, e.at) > 5;
        items.push({
          id: e.id,
          kind: "scheduled",
          text: late ? `${e.text} (was due ${shortTime(e.at)})` : e.text,
          entities: e.entities,
          ...(e.thread ? { thread: e.thread } : {}),
        });
      }
    }

    for (const e of config.events.conditional) {
      const lastFired = ev.fired[e.id];
      if (lastFired && (e.once || diffMinutes(to, lastFired) < REFIRE_MINUTES)) continue;
      if (conditionHolds(e.when, state, config, to)) {
        items.push({ id: e.id, kind: "conditional", text: e.text, entities: e.entities });
      }
    }

    if (ev.last_eval && config.events.random.length) {
      const hours = Math.min(MAX_ELAPSED_HOURS, Math.max(0, diffMinutes(to, ev.last_eval) / 60));
      for (const e of config.events.random) {
        const p = 1 - Math.pow(1 - e.chance_per_hour, hours);
        const roll = rng.next();
        if (roll < p) {
          const total = e.entries.reduce((sum, x) => sum + x.weight, 0);
          let pick = rng.next() * total;
          const entry = e.entries.find((x) => (pick -= x.weight) < 0) ?? e.entries[0];
          if (entry) items.push({ id: `${e.id}@${to}`, kind: "random", text: entry.text, entities: [] });
        } else {
          rng.next();
        }
      }
    }
    return items;
  },

  onTurnCommitted(state, _config, ctx) {
    const s = structuredClone(state);
    const ev = eventsOf(s);
    for (const item of ctx.due) {
      if (item.kind === "scheduled" || item.kind === "conditional") ev.fired[item.id] = ctx.now;
    }
    ev.last_eval = ctx.now;
    s.modules.events = ev;
    return s;
  },

  snapshot(state, config) {
    const ev = eventsOf(state);
    const now = state.clock.now;
    const upcoming = config.events.scheduled
      .filter((e) => !ev.fired[e.id] && diffMinutes(e.at, now) > 0 && diffMinutes(e.at, now) <= 72 * 60)
      .sort((a, b) => parseLocal(a.at) - parseLocal(b.at))
      .slice(0, 5)
      .map((e) => `${shortTime(e.at)} ${e.text}`);
    return upcoming.length ? [`Upcoming: ${upcoming.join("; ")}`] : [];
  },

  render: () => ({}),
};
