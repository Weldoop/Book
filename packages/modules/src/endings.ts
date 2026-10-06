import { addMinutes } from "@book/engine";
import type { Config, DueItem, Ending, State } from "@book/schema";
import { conditionHolds } from "./events.ts";
import { inventoryOf } from "./inventory.ts";
import { statDef, statsOf } from "./stats.ts";

/**
 * The first configured ending whose condition now holds and which has not fired before.
 * Called after a turn is applied, so it reads committed state only.
 */
export function pickEnding(state: State, config: Config): Ending | null {
  if (state.ending) return null;
  const seen = new Set(state.endings_seen);
  return (
    config.endings.find((e) => !seen.has(e.id) && conditionHolds(e.when, state, config, state.clock.now)) ?? null
  );
}

export function markEnding(state: State, ending: Ending): State {
  return {
    ...state,
    ending: { id: ending.id, turn: state.turn, continuable: ending.continue !== undefined },
    endings_seen: [...state.endings_seen, ending.id],
  };
}

export function endingById(config: Config, id: string): Ending | undefined {
  return config.endings.find((e) => e.id === id);
}

/** The due item that opens the first scene after a continuation, so the GM is told where it is. */
export function continuationDue(ending: Ending): DueItem {
  return {
    id: `ending.${ending.id}.continue`,
    kind: "scheduled",
    text: ending.continue?.note ?? "",
    entities: ending.continue?.location ? [ending.continue.location] : [],
  };
}

/**
 * Carries the story on from a fired ending. Everything is deterministic: time passes, the player
 * is moved, stats are forced and possessions are stripped, all by code rather than by the model.
 */
export function applyContinuation(state: State, config: Config, ending: Ending): State {
  const cont = ending.continue;
  if (!cont) return state;
  const s = structuredClone(state);

  if (cont.skip_minutes > 0) s.clock = { now: addMinutes(s.clock.now, cont.skip_minutes) };

  const player = s.entities[config.player_id];
  if (player) s.entities[config.player_id] = { ...player, location: cont.location, last_touched: s.turn };

  const entries = Object.entries(cont.set_stats);
  if (entries.length > 0) {
    const stats = { values: { ...statsOf(s).values } };
    for (const [key, value] of entries) {
      if (statDef(config, key)) stats.values[key] = value;
    }
    s.modules.stats = stats;
  }

  if (cont.clear_inventory) {
    const inv = inventoryOf(s);
    s.modules.inventory = { owners: { ...inv.owners, [config.player_id]: {} }, catalog: inv.catalog ?? [] };
  }

  s.ending = null;
  return s;
}
