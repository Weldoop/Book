import type { Config, State } from "@book/schema";

/** How many phrases one turn may mark. Enough for a new person, a place, and an object. */
export const HIGHLIGHT_CAP = 4;

const STOP = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "you",
  "your",
  "the",
  "this",
  "that",
  "there",
  "here",
  "and",
  "but",
  "with",
  "from",
  "into",
  "onto",
  "they",
  "them",
  "she",
  "her",
  "his",
  "him",
  "have",
  "been",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function appears(narration: string, phrase: string): boolean {
  return new RegExp(`\\b${escapeRegExp(phrase).replace(/\s+/g, "\\s+")}\\b`, "i").test(narration);
}

function knownPhrases(state: State, config: Config): Set<string> {
  const known = new Set<string>();
  for (const entity of Object.values(state.entities)) {
    known.add(norm(entity.name));
    for (const alias of entity.aliases) known.add(norm(alias));
    known.add(norm(entity.id.replace(/[_-]/g, " ")));
  }
  for (const item of config.items) {
    known.add(norm(item.name));
    known.add(norm(item.id.replace(/[_-]/g, " ")));
  }
  return known;
}

function isKnown(phrase: string, known: Set<string>): boolean {
  const needle = norm(phrase);
  if (needle.length < 3) return true;
  return known.has(needle);
}

/** Capitalised names that are not the first word of a sentence. */
function properNouns(narration: string): string[] {
  const found: string[] = [];
  const pattern = /\b[A-Z][a-zA-Z'’-]{2,}(?:\s+[A-Z][a-zA-Z'’-]{2,})?/g;
  for (const match of narration.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const before = narration.slice(Math.max(0, match.index - 2), match.index);
    if (match.index === 0 || /[.!?\n]\s*$/.test(before) || /[.!?\n]/.test(before)) continue;
    found.push(match[0]);
  }
  return found;
}

/**
 * Up to four phrases that are in the narration and not already in the save.
 * The model's list comes first. Proper nouns fill any room left, so a new name
 * is still marked when the model forgets the field.
 */
export function selectHighlights(narration: string, requested: string[] | undefined, state: State, config: Config): string[] {
  const known = knownPhrases(state, config);
  const out: string[] = [];
  const push = (phrase: string) => {
    if (out.length >= HIGHLIGHT_CAP) return;
    const clean = phrase.trim().replace(/\s+/g, " ");
    if (clean.length < 3 || clean.length > 40) return;
    if (!appears(narration, clean)) return;
    if (clean.split(" ").every((word) => STOP.has(word.toLowerCase()))) return;
    if (isKnown(clean, known)) return;
    if (out.some((item) => norm(item) === norm(clean))) return;
    out.push(clean);
  };
  for (const phrase of requested ?? []) push(phrase);
  if (out.length < HIGHLIGHT_CAP) {
    for (const phrase of properNouns(narration)) push(phrase);
  }
  return out;
}
