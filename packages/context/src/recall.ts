import { diffMinutes, keepWitnessed, placeWords, sharedContentWords } from "@book/engine";
import type { Config, Fact, State, Thread } from "@book/schema";

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

const STOP = new Set([
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "did",
  "does",
  "have",
  "has",
  "had",
  "with",
  "that",
  "this",
  "they",
  "them",
  "your",
  "yours",
  "from",
  "before",
  "after",
  "tell",
  "told",
  "said",
  "were",
  "been",
  "going",
  "would",
  "could",
  "should",
  "about",
  "there",
  "their",
  "into",
  "onto",
  "over",
  "under",
  "than",
  "then",
  "also",
  "just",
  "only",
  "some",
  "more",
  "most",
  "much",
  "many",
  "will",
  "shall",
  "must",
  "want",
  "like",
  "back",
  "down",
  "here",
  "please",
  "again",
  "still",
]);

interface MoneyEntry {
  clock: string;
  key: string;
  amount: number;
  reason: string;
}

function contentWords(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .split(" ")
    .filter((word) => word.length >= 4 && !STOP.has(word));
  return [...new Set(words)];
}

function scoreLine(line: string, words: string[]): number {
  const hay = line.toLowerCase();
  return words.reduce((n, word) => n + (hay.includes(word) ? 1 : 0), 0);
}

function threadLine(thread: Thread): string {
  const due = thread.due ? ` due ${thread.due}` : "";
  return `Thread ${thread.status}${due}: ${thread.text}`;
}

/**
 * Player names and facts, what they said, the money ledger, what they carry,
 * and open plus recent failed threads. Used to answer from the save. Not trimmed.
 */
export function recallLines(state: State, config: Config): string[] {
  const lines: string[] = [];
  const player = state.entities[config.player_id];
  if (player) {
    const aliases = player.aliases.filter((alias) => !/^(me|myself|i)$/i.test(alias));
    if (aliases.length > 0) lines.push(`Player names: ${player.name}; also ${aliases.join(", ")}`);
    else lines.push(`Player names: ${player.name}`);
    for (const fact of live(player.facts, state.clock.now)) lines.push(`Player fact: ${fact.text}`);
  }
  for (const entry of state.ledger ?? []) lines.push(`Said: ${entry.text}`);
  const money =
    (state.modules.stats as { ledger?: MoneyEntry[] } | undefined)?.ledger?.slice(-10) ?? [];
  for (const entry of money) {
    lines.push(`Ledger: ${entry.clock} ${entry.amount} ${entry.key} ${entry.reason}`.trim());
  }
  const bag =
    (state.modules.inventory as { owners?: Record<string, Record<string, number>> } | undefined)?.owners?.[
      config.player_id
    ] ?? {};
  for (const [id, qty] of Object.entries(bag)) {
    if (qty > 0) lines.push(`Carrying: ${id} x${qty}`);
  }
  const open = state.threads.filter((thread) => thread.status === "open");
  const failed = state.threads
    .filter((thread) => thread.status === "failed")
    .sort((a, b) => (b.resolved_turn ?? 0) - (a.resolved_turn ?? 0))
    .slice(0, 8);
  for (const thread of [...open, ...failed]) lines.push(threadLine(thread));
  return lines;
}

function factLines(state: State, config: Config): string[] {
  const lines: string[] = [];
  for (const entity of Object.values(state.entities)) {
    if (entity.id === config.player_id) continue;
    for (const fact of live(entity.facts, state.clock.now).slice(0, 8)) {
      lines.push(`${entity.name}: ${fact.text}`);
    }
  }
  return lines;
}

const PRONOUN_QUESTION = /\b(?:pronouns?|he or she|she or he|his or her|him or her)\b/i;

function storedPronoun(entity: { name: string; tags: string[] }): string | null {
  const tag = entity.tags.find((item) => item.startsWith("pronoun:"));
  if (!tag) return null;
  const pronoun = tag.slice("pronoun:".length);
  return pronoun === "he" || pronoun === "she" || pronoun === "they" ? pronoun : null;
}

/**
 * A pronoun question is answered from the stored pronoun, in a sentence.
 * It does not dump the ledger. Null means the question was not about a pronoun.
 */
function pronounAnswer(state: State, question: string): string | null {
  if (!PRONOUN_QUESTION.test(question)) return null;
  const people = Object.values(state.entities).filter((entity) => entity.type === "person");
  const named = people.filter((entity) => {
    const names = [entity.name, ...entity.aliases];
    return names.some((name) => name.trim().length >= 3 && new RegExp(`\\b${name}\\b`, "i").test(question));
  });
  if (named.length !== 1 || !named[0]) return "No pronoun is recorded.";
  const person = named[0];
  const pronoun = storedPronoun(person);
  if (!pronoun) return `No pronoun is recorded for ${person.name}.`;
  return `${person.name} uses ${pronoun}.`;
}

const HAS_TIME = /\b(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)|o'clock)\b/i;
const ASKS_TIME = /\b(?:what time|when)\b/i;
const ASKS_SAID = /\bdid i say\b|\bi said\b|\bwe said\b/i;

/**
 * A short answer from the save when the question hits a name, a purchase, or a stored fact.
 * A time question only returns a line that states a time. "What did I say" only returns
 * what was said. A weak overlap does not answer, and the cheap read still runs.
 * Null means nothing here is the answer. Nothing here is invented.
 */
export function answerFromSave(state: State, config: Config, question: string): string | null {
  const pronouns = pronounAnswer(state, question);
  if (pronouns) return pronouns;
  const words = contentWords(question);
  const asksTime = ASKS_TIME.test(question);
  const asksSaid = ASKS_SAID.test(question);
  const askedBuy =
    !asksTime &&
    !asksSaid &&
    /\b(buy|bought|order|ordered|spend|spent|pay|paid|purchase|purchased|owe|owed|debt)\b/i.test(question);
  const askedName = /\b(name|nickname|called|call me|call you)\b/i.test(question);
  const saved = recallLines(state, config);
  let pool = [...saved.filter((line) => askedBuy || !line.startsWith("Ledger:")), ...factLines(state, config)];
  if (asksSaid) pool = pool.filter((line) => line.startsWith("Said:"));
  if (asksTime) {
    const timed = pool.filter((line) => HAS_TIME.test(line));
    const aboutIt = timed.filter((line) => scoreLine(line, words) > 0);
    const agreed = /\b(?:promise|promised|return|back|borrow|borrowed|mower)\b/i.test(question);
    pool = aboutIt.length > 0 ? aboutIt : agreed ? timed.filter((line) => line.startsWith("Said:")) : [];
    if (pool.length === 0) return null;
  }
  const scored = pool
    .map((line) => ({ line, score: scoreLine(line, words) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.line.length - b.line.length);
  const picked: string[] = [];
  const add = (line: string) => {
    if (!picked.includes(line)) picked.push(line);
  };
  if (askedName) {
    for (const line of saved) {
      if (line.startsWith("Player names:") || (line.startsWith("Player fact:") && scoreLine(line, words) > 0)) add(line);
    }
  }
  if (askedBuy) {
    for (const line of saved) {
      if (line.startsWith("Ledger:")) add(line);
    }
  }
  const best = scored[0]?.score ?? 0;
  if (best > 0) {
    for (const row of scored) {
      if (row.score < best && picked.length > 0) break;
      add(row.line);
      if (picked.length >= 4) break;
    }
  } else if (asksTime) {
    for (const line of pool) {
      add(line);
      if (picked.length >= 4) break;
    }
  }
  if (picked.length === 0) return null;
  return `[${picked.slice(0, 6).join(" ")}]`;
}
