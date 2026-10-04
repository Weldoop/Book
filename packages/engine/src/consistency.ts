import type { Config, Op, State, TurnDraft, Violation } from "@book/schema";
import { playerLocation } from "./core.ts";

const TRIP =
  /\b(?:walk|head|go|travel|ride|drive|hurry|set off|leave)\b[^.]{0,40}?\b(?:to|towards|toward|into)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{2,40})/gi;

const REFUSAL =
  /\b(?:still in|still at|haven't left|have not left|did not leave|didn't leave|not yet|there is no|there's no|you are still|you're still|can wait|hasn't happened|has not happened|you haven't|you have not)\b|\bno \w+ to leave\b/i;

const PAY =
  /\b(buy|bought|pay|paid|order|ordered|purchase|purchased|spend|spent)\b/gi;

const RELEASE =
  /\b(eat|ate|drink|drank|finish|finished|put|leave|left|hand|handed|give|gave|given|return|returned|replace|replaced)\b/gi;

const NEGATED = /\b(?:can't|cannot|don't|do not|didn't|did not|won't|will not|never|not)\s*$/i;

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWord(hay: string, needle: string): boolean {
  if (needle.length < 3) return false;
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(hay);
}

/** "bed" is the bedroom; "sea" is the seafront. A short stem only counts with a place ending. */
const PLACE_TAIL = new Set(["room", "front", "side", "way", "yard", "house", "shop"]);

function wordCovers(word: string, dest: string): boolean {
  if (word === dest) return true;
  if (dest.length < 3 || !word.startsWith(dest)) return false;
  return PLACE_TAIL.has(word.slice(dest.length));
}

function cleanDestination(raw: string): string {
  const cut = raw.split(/\b(?:again|and|then|if|but|so|while|when|please)\b/)[0] ?? raw;
  return norm(cut).replace(/^(?:the|a|an)\s+/, "");
}

/** The last place the player asked to go to, if this input is a trip. */
export function tripDestination(input: string): string | null {
  let last: string | null = null;
  for (const match of input.toLowerCase().matchAll(new RegExp(TRIP.source, "gi"))) {
    const dest = cleanDestination(match[1] ?? "");
    if (dest.length >= 3) last = dest;
  }
  return last;
}

export function isTravelRefusal(narration: string): boolean {
  return new RegExp(REFUSAL.source, "i").test(narration);
}

function placeMatches(name: string, aliases: string[], id: string, dest: string): boolean {
  const needle = norm(dest);
  if (needle.length < 3) return false;
  const names = [name, ...aliases, id.replace(/[_-]/g, " ")].map(norm).filter((n) => n.length > 0);
  return names.some((n) => {
    if (n === needle || hasWord(n, needle) || hasWord(needle, n)) return true;
    const words = n.split(" ");
    return needle.split(" ").every((part) => words.some((word) => wordCovers(word, part)));
  });
}

function violation(severity: Violation["severity"], code: string, message: string): Violation {
  return { severity, code, message };
}

function checkAt(after: State, config: Config, draft: TurnDraft): Violation[] {
  if (!draft.at) return [];
  const place = after.entities[draft.at];
  const here = playerLocation(after, config);
  if (!place || place.type !== "place") {
    return [
      violation(
        "fixable",
        "location_mismatch",
        `The draft says the narration stops at '${draft.at}', which is not a place. Create that place or set "at" to the place id where the narration stops, and entity.move the player there.`,
      ),
    ];
  }
  if (here !== draft.at) {
    return [
      violation(
        "fixable",
        "location_mismatch",
        `The draft says the narration stops at '${draft.at}' but the player is at '${here ?? "nowhere"}'. entity.move the player to '${draft.at}'.`,
      ),
    ];
  }
  return [];
}

function checkTravel(before: State, after: State, config: Config, draft: TurnDraft, input: string, applied: Op[]): Violation[] {
  const dest = tripDestination(input);
  if (!dest) return [];
  const end = playerLocation(after, config);
  const endEntity = end ? after.entities[end] : undefined;
  const created = new Set<string>();
  for (const op of applied) {
    if (op.op === "entity.create" && op.type === "place") created.add(op.id);
  }
  if (endEntity && placeMatches(endEntity.name, endEntity.aliases, endEntity.id, dest)) return [];
  if (end && created.has(end)) return [];
  if (isTravelRefusal(draft.narration)) {
    const prev = before.window.at(-1);
    if (prev && tripDestination(prev.input) && isTravelRefusal(prev.narration)) {
      return [
        violation(
          "game_breaking",
          "trip_insisted",
          `The player already asked to leave and was refused. They asked again to go to "${dest}". Do not refuse twice: narrate the departure, entity.create the place if it does not exist, entity.move the player, and set "at" to that place id.`,
        ),
      ];
    }
    return [];
  }
  const here = endEntity?.name ?? "the same place";
  return [
    violation(
      "fixable",
      "arrived_elsewhere",
      `The player asked to go to "${dest}" but the narration leaves them at ${here}${end ? ` [${end}]` : ""}. entity.move them to a place whose name matches "${dest}", creating it with entity.create in this delta if it does not exist, and set "at" to that place id.`,
    ),
  ];
}

function pluralize(word: string): string {
  if (word.endsWith("s")) return word;
  return `${word}s`;
}

function singular(phrase: string): string {
  const word = phrase.split(" ").at(-1) ?? phrase;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function itemPhrases(item: { id: string; name: string }): string[] {
  const name = norm(item.name);
  const idPhrase = norm(item.id.replace(/[_-]/g, " "));
  const parts = name.split(" ").filter(Boolean);
  const first = parts[0] ?? "";
  const phrases = new Set<string>();
  if (name.length >= 3) phrases.add(name);
  if (idPhrase.length >= 3) phrases.add(idPhrase);
  if (item.id.includes("-") || item.id.includes("_")) phrases.add(item.id.toLowerCase());
  if (first.length >= 3) {
    phrases.add(pluralize(first));
    if (parts.length > 1) phrases.add([pluralize(first), ...parts.slice(1)].join(" "));
  }
  if (!idPhrase.includes(" ") && idPhrase.length >= 3) phrases.add(pluralize(idPhrase));
  return [...phrases];
}

interface Mention {
  id: string;
  name: string;
  start: number;
  end: number;
  phrase: string;
}

function findMentions(narration: string, items: { id: string; name: string }[]): Mention[] {
  const text = narration.toLowerCase();
  const hits: Mention[] = [];
  for (const item of items) {
    for (const phrase of itemPhrases(item)) {
      const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "g");
      for (const match of text.matchAll(re)) {
        if (match.index === undefined) continue;
        hits.push({ id: item.id, name: item.name, start: match.index, end: match.index + phrase.length, phrase });
      }
    }
  }
  hits.sort((a, b) => {
    const length = b.end - b.start - (a.end - a.start);
    if (length !== 0) return length;
    const rank = (hit: Mention) => (norm(hit.id) === singular(hit.phrase) || norm(hit.name) === hit.phrase ? 0 : 1);
    return rank(a) - rank(b) || a.start - b.start;
  });
  const kept: Mention[] = [];
  for (const hit of hits) {
    if (kept.some((other) => hit.start < other.end && hit.end > other.start)) continue;
    kept.push(hit);
  }
  return kept;
}

function hasVerb(window: string, pattern: RegExp): boolean {
  const re = new RegExp(pattern.source, "gi");
  for (const match of window.matchAll(re)) {
    const at = match.index ?? 0;
    const before = window.slice(Math.max(0, at - 20), at);
    const word = match[0].toLowerCase();
    if (word === "order" && /\bin\s+$/i.test(before)) continue;
    if (NEGATED.test(before)) continue;
    return true;
  }
  return false;
}

function carrying(state: State, playerId: string, itemId: string): boolean {
  const inv = state.modules.inventory as { owners?: Record<string, Record<string, number>> } | undefined;
  return (inv?.owners?.[playerId]?.[itemId] ?? 0) > 0;
}

function spentMoney(ops: Op[], config: Config): boolean {
  const key = config.stats.find((stat) => stat.type === "currency")?.key ?? "money";
  return ops.some((op) => op.op === "stat.add" && op.key === key && op.amount < 0);
}

function addedItem(ops: Op[], itemId: string): boolean {
  return ops.some((op) => op.op === "inventory.add" && op.item === itemId);
}

function removedItem(ops: Op[], playerId: string, itemId: string): boolean {
  return ops.some((op) => op.op === "inventory.remove" && op.owner === playerId && op.item === itemId);
}

function checkItems(after: State, config: Config, draft: TurnDraft, applied: Op[]): Violation[] {
  if (config.items.length === 0) return [];
  const text = draft.narration.toLowerCase();
  const byId = new Map<string, { name: string; pay: boolean; release: boolean }>();
  for (const mention of findMentions(draft.narration, config.items)) {
    const window = text.slice(Math.max(0, mention.start - 60), mention.start);
    const row = byId.get(mention.id) ?? { name: mention.name, pay: false, release: false };
    row.pay = row.pay || hasVerb(window, PAY);
    row.release = row.release || hasVerb(window, RELEASE);
    byId.set(mention.id, row);
  }
  const out: Violation[] = [];
  for (const [id, row] of byId) {
    if (row.pay && (!spentMoney(applied, config) || !addedItem(applied, id))) {
      out.push(
        violation(
          "fixable",
          "unpaid_item",
          `The narration buys or orders "${row.name}" (${id}) without both a payment and an inventory.add. Add a negative stat.add for the catalog price and inventory.add of '${id}', or do not narrate the purchase.`,
        ),
      );
    }
    if (row.release && carrying(after, config.player_id, id) && !removedItem(applied, config.player_id, id)) {
      out.push(
        violation(
          "fixable",
          "item_still_held",
          `The narration has the player eat, drink, or put down "${row.name}" (${id}) but they still carry it. inventory.remove '${id}', or do not narrate letting it go.`,
        ),
      );
    }
  }
  return out;
}

/** Checks that run after a legal delta: place, travel, and catalog items. They do not invent ops. */
export function consistencyViolations(
  before: State,
  after: State,
  config: Config,
  draft: TurnDraft,
  input: string,
  applied: Op[],
): Violation[] {
  return [
    ...checkAt(after, config, draft),
    ...checkTravel(before, after, config, draft, input, applied),
    ...checkItems(after, config, draft, applied),
  ];
}
