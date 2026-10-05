import type { State } from "@book/schema";
import { addMinutes, diffMinutes } from "./time.ts";

/**
 * In-world hours a person keeps a memory. Importance 3 is absent on purpose:
 * a fight, a betrayal, or real harm does not lapse.
 */
export const MEMORY_HOURS = { 1: 24, 2: 24 * 7 } as const;

export function memoryExpiry(now: string, importance: 1 | 2 | 3): string | undefined {
  if (importance === 3) return undefined;
  return addMinutes(now, MEMORY_HOURS[importance] * 60);
}

/**
 * Drops memories whose time has passed. A fact with no expiry stays, and so does
 * anything that is not a person: a place does not forget that the kettle sticks.
 */
export function forgetMemories(state: State): void {
  const now = state.clock.now;
  for (const entity of Object.values(state.entities)) {
    if (entity.type !== "person") continue;
    entity.facts = entity.facts.filter((fact) => fact.expires === undefined || diffMinutes(now, fact.expires) < 0);
  }
}
