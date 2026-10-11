import type { Fact, State } from "@book/schema";
import { sharedContentWords } from "./threads.ts";
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

const PLACE_SKIP = new Set(["the", "and", "for", "with", "from"]);

/** Place names and aliases, folded, so "café" and "cafe" are the same word. */
export function placeWords(state: State): string[] {
  const out = new Set<string>();
  for (const entity of Object.values(state.entities)) {
    if (entity.type !== "place") continue;
    for (const label of [entity.name, ...entity.aliases]) {
      const words = fold(label)
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !PLACE_SKIP.has(word));
      for (const word of words) {
        if (word.length >= 4 || words.length === 1) out.add(word);
      }
    }
  }
  return [...out];
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function namesPlace(text: string, places: readonly string[]): string[] {
  const hay = fold(text);
  return places.filter((place) => new RegExp(`(?<![a-z0-9])${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(hay));
}

/**
 * The same matter, told at two different places. "Sold the camera at the cafe"
 * and "sold the camera at the market" disagree. Two memories that share a place do not.
 */
export function factsDisagree(a: string, b: string, places: readonly string[]): boolean {
  if (sharedContentWords(a, b) < 2) return false;
  const left = namesPlace(a, places);
  const right = namesPlace(b, places);
  if (left.length === 0 || right.length === 0) return false;
  const known = new Set(left);
  return right.every((place) => !known.has(place));
}

/** Higher importance wins. The same importance keeps the earlier witness, so a later retelling does not overwrite it. */
function witnessRank(fact: Fact): number {
  return fact.importance * 1_000_000 - fact.turn;
}

export type FactDecision = "append" | "drop" | "replace";

/** A later line about the same matter does not sit beside the witnessed one. A more important correction replaces it. */
export function factDecision(existing: readonly Fact[], incoming: Fact, places: readonly string[]): FactDecision {
  const hits = existing.filter((fact) => factsDisagree(fact.text, incoming.text, places));
  if (hits.length === 0) return "append";
  const strongest = hits.reduce((best, fact) => (fact.importance > best.importance ? fact : best));
  return incoming.importance > strongest.importance ? "replace" : "drop";
}

/** Collapses a contradicted pair down to the witnessed fact, for a prompt that already stored both. */
export function keepWitnessed(facts: readonly Fact[], places: readonly string[]): Fact[] {
  const out: Fact[] = [];
  for (const fact of facts) {
    const hit = out.findIndex((kept) => factsDisagree(kept.text, fact.text, places));
    if (hit < 0) {
      out.push(fact);
      continue;
    }
    const kept = out[hit];
    if (kept && witnessRank(fact) > witnessRank(kept)) out[hit] = fact;
  }
  return out;
}
