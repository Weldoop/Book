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

/** "Owen's" is Owen. The possessive is not part of the name. */
function bareName(phrase: string): string {
  return phrase.replace(/(?:'|’)s?$/u, "").trim();
}

/** Every name the save has, each word of a person's name included, so "Tomos" is known when "Tomos Reed" is. */
function knownPhrases(state: State, config: Config): Set<string> {
  const known = new Set<string>();
  const add = (text: string) => {
    const n = norm(text);
    if (!n) return;
    known.add(n);
    for (const word of n.split(" ")) if (word.length >= 3) known.add(word);
  };
  for (const entity of Object.values(state.entities)) {
    add(entity.name);
    for (const alias of entity.aliases) add(alias);
    add(entity.id.replace(/[_-]/g, " "));
  }
  for (const item of config.items) {
    add(item.name);
    add(item.id.replace(/[_-]/g, " "));
  }
  return known;
}

function isKnown(phrase: string, known: Set<string>): boolean {
  const needle = norm(phrase);
  if (needle.length < 3) return true;
  if (known.has(needle)) return true;
  return needle.split(" ").every((word) => word.length < 3 || known.has(word));
}

/**
 * A word that opens a sentence, a quotation, or a clause after a dash is capitalised for that
 * reason alone. A name is marked only where the capital letter cannot be explained that way.
 */
function startsClause(narration: string, index: number): boolean {
  if (index === 0) return true;
  const before = narration.slice(Math.max(0, index - 4), index);
  return /(?:^|[.!?\n:;]|[—–-]|['"“‘(\[*])\s*$/u.test(before) || /[.!?\n]\s+$/.test(before);
}

/**
 * A word the model listed may open a sentence ("Seren waves from the door"). It may not open
 * a quotation or a dash clause, run straight into punctuation, or be a contraction: those are
 * "Alright,", "—I'm", and "Yeah!" wearing a capital letter.
 */
function plainSentenceStart(narration: string, index: number, length: number): boolean {
  const before = narration.slice(Math.max(0, index - 4), index);
  // An opening quote follows a space or a dash; a closing one follows punctuation and ends the sentence before.
  if (/(?:^|\s|[—–-])['"“‘]\s*$/u.test(before) || /[—–-]\s*$/u.test(before)) return false;
  const after = narration.slice(index + length, index + length + 2);
  if (/^\s*[,!?;:—–-]/u.test(after)) return false;
  return true;
}

/** The phrase appears capitalised where a capital means a name, somewhere in the narration. */
function appearsAsName(narration: string, phrase: string, requested: boolean): boolean {
  if (/['’]/u.test(phrase)) return false;
  const body = escapeRegExp(phrase).replace(/\s+/g, "\\s+");
  const re = new RegExp(`\\b${body}\\b`, "g");
  for (const match of narration.matchAll(re)) {
    if (match.index === undefined) continue;
    const found = match[0];
    if (found[0] !== found[0]?.toUpperCase()) continue;
    if (!startsClause(narration, match.index)) return true;
    if (requested && plainSentenceStart(narration, match.index, found.length)) return true;
  }
  return false;
}

/** Capitalised words and pairs that do not open a sentence, a quote, or a dash clause. */
function properNouns(narration: string): string[] {
  const found: string[] = [];
  const pattern = /\b[A-Z][a-zA-Z'’-]{2,}(?:\s+[A-Z][a-zA-Z'’-]{2,})?/g;
  for (const match of narration.matchAll(pattern)) {
    if (match.index === undefined || startsClause(narration, match.index)) continue;
    found.push(match[0]);
  }
  return found;
}

/**
 * Up to four names that are in the narration and not already in the save.
 * The model's list comes first. Proper nouns fill any room left, so a new name
 * is still marked when the model forgets the field. A word that is only ever
 * capitalised at the start of a sentence or a quotation is not a name.
 */
export function selectHighlights(narration: string, requested: string[] | undefined, state: State, config: Config): string[] {
  const known = knownPhrases(state, config);
  const out: string[] = [];
  const push = (phrase: string, requested: boolean) => {
    if (out.length >= HIGHLIGHT_CAP) return;
    const clean = bareName(phrase.trim().replace(/\s+/g, " "));
    if (clean.length < 3 || clean.length > 40) return;
    if (!appearsAsName(narration, clean, requested)) return;
    if (clean.split(" ").every((word) => STOP.has(word.toLowerCase()) || STOP.has(word.toLowerCase().replace(/s$/, "")))) return;
    if (isKnown(clean, known)) return;
    if (out.some((item) => norm(item) === norm(clean) || norm(item).includes(norm(clean)) || norm(clean).includes(norm(item)))) return;
    out.push(clean);
  };
  for (const phrase of requested ?? []) push(phrase, true);
  if (out.length < HIGHLIGHT_CAP) {
    for (const phrase of properNouns(narration)) push(phrase, false);
  }
  return out;
}
