import { diffMinutes, keepWitnessed, placeWords, sharedContentWords } from "@book/engine";
import type { Fact, State, Thread } from "@book/schema";

const PROMISED =
  /£|\b(?:owe|owes|owed|debt|noon|midnight|o'clock|\d{1,2}:\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/i;

/**
 * The line the player just said, their name and aliases, and any open debt or promised time.
 * Fact selection matches this. It is not a model call.
 */
export function recallHaystack(input: string, threads: readonly Pick<Thread, "status" | "text" | "due">[], playerTerms: readonly string[]): string {
  const lines = [input, ...playerTerms];
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    if (thread.due !== undefined || PROMISED.test(thread.text)) lines.push(thread.text);
  }
  return lines.join("\n");
}

function live(facts: readonly Fact[], now: string): Fact[] {
  return facts.filter((fact) => fact.expires === undefined || diffMinutes(now, fact.expires) < 0);
}

function byStrength(a: Fact, b: Fact): number {
  return b.importance - a.importance || b.turn - a.turn;
}

/**
 * Facts that share a word with the haystack jump ahead of colder ones.
 * A contradicted pair keeps the witnessed fact. The count stays at `limit`.
 */
export function selectRecalledFacts(facts: readonly Fact[], now: string, haystack: string, places: readonly string[], limit: number): Fact[] {
  if (limit <= 0) return [];
  const ranked = [...keepWitnessed(live(facts, now), places)].sort(byStrength);
  const hay = haystack.trim();
  const matches = hay.length > 0 ? ranked.filter((fact) => sharedContentWords(fact.text, hay) >= 1) : [];
  const picked: Fact[] = [];
  const seen = new Set<Fact>();
  for (const fact of matches) {
    if (picked.length >= limit) break;
    picked.push(fact);
    seen.add(fact);
  }
  for (const fact of ranked) {
    if (picked.length >= limit) break;
    if (seen.has(fact)) continue;
    picked.push(fact);
  }
  return picked;
}

export function entityPlaces(state: State): string[] {
  return placeWords(state);
}
