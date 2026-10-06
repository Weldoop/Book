import type { Config, Op, State, TurnDraft, Violation } from "@book/schema";
import { catalogItems } from "./catalog.ts";
import { playerLocation } from "./core.ts";

const DEST = String.raw`(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{2,40})`;

/**
 * A refused trip says the player has not left. "Cerys is still at the table" is not that:
 * the word "still" there is about a person, and it must not hide a missing entity.move.
 */
const REFUSAL =
  /\b(?:haven't left|have not left|did not leave|didn't leave|not yet|there is no|there's no|you are still|you're still|can wait|hasn't happened|has not happened|you haven't|you have not)\b|\bno \w+ to leave\b/i;

const PAY =
  /\b(buy|bought|pay|paid|order|ordered|purchase|purchased|spend|spent)\b/gi;

const RELEASE =
  /\b(eat|ate|drink|drank|finish|finished|hand|handed|give|gave|given|return|returned|replace|replaced)\b/gi;

/** "put" and "leave" set an item down. Plugging a phone in, or leaving it on the side, does not. */
const PUT_OR_LEAVE = /\b(put|leave|left)\b/gi;

/** "Set down the cob" is the good leaving the hands. Gear set down in the room stays. */
const SET_DOWN = /\bset down\b/gi;

const PARKED = /\b(?:on(?:to)?\s+charge|to\s+charge|on\s+the\s+side|on\s+the\s+bedside)\b/i;

/** The word after "to" is the errand, not a place: "to check my phone", "to say sorry". */
const PURPOSE = new Set([
  "ask",
  "buy",
  "call",
  "charge",
  "check",
  "find",
  "get",
  "grab",
  "look",
  "meet",
  "pick",
  "read",
  "say",
  "see",
  "tell",
  "text",
  "watch",
]);

const NEGATED = /\b(?:can't|cannot|don't|do not|didn't|did not|won't|will not|never|not)\s*$/i;

/** A direction, not a destination, unless the book actually names a place that. */
const VAGUE_DEST = new Set(["town", "outside", "upstairs", "downstairs", "inside", "home", "outdoors", "indoors"]);

const ANOTHER = /\b(?:another|one more|a second|extra)\b/i;

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
  // "for", "as" and a second "to" are the errand or the next clause ("the shop for a cob", "the coop as I leave"), not the place.
  const cut = raw.split(/\b(?:again|and|then|if|but|so|while|when|please|for|as)\b|\bto\b/)[0] ?? raw;
  return norm(cut).replace(/^(?:the|a|an)\s+/, "");
}

function isPlaceDestination(dest: string): boolean {
  const first = dest.split(" ")[0] ?? "";
  return dest.length >= 3 && !PURPOSE.has(first);
}

function isLocalStep(dest: string, local: string[]): boolean {
  const needle = norm(dest);
  return local.some((step) => norm(step) === needle);
}

function departing(verb: string): boolean {
  const word = verb.trim().toLowerCase();
  return word === "leave" || word === "left";
}

/** "leave to the garden" is a trip. "as I leave, say to the lad" is not, so the preposition has to come next. */
function immediateTripPattern(verbs: string[], prepositions: string): RegExp | null {
  const list = verbs.map((verb) => verb.trim().toLowerCase()).filter(departing);
  if (list.length === 0) return null;
  const body = list.map(escapeRegExp).join("|");
  return new RegExp(`\\b(?:${body})\\s+(?:${prepositions})\\s+${DEST}`, "gi");
}

/** Longer phrases first, so "set a course" wins over "set". Words come from the book, so they are escaped. */
function verbPattern(verbs: string[], prepositions: string, span: number): RegExp | null {
  const list = verbs.map((verb) => verb.trim().toLowerCase()).filter((verb) => verb.length >= 2);
  list.sort((a, b) => b.length - a.length);
  if (list.length === 0) return null;
  const body = list.map(escapeRegExp).join("|");
  return new RegExp(`\\b(?:${body})\\b[^.]{0,${span}}?\\b(?:${prepositions})\\s+${DEST}`, "gi");
}

/** The last place the player asked to go to, using this book's travel words. */
export function tripDestination(input: string, config: Config): string | null {
  const hits: { index: number; dest: string }[] = [];
  const scan = (pattern: RegExp | null) => {
    if (!pattern) return;
    for (const match of input.toLowerCase().matchAll(pattern)) {
      const dest = cleanDestination(match[1] ?? "");
      if (isPlaceDestination(dest) && match.index !== undefined) hits.push({ index: match.index, dest });
    }
  };
  const travel = config.travel;
  scan(verbPattern(
    travel.means.filter((verb) => !departing(verb)),
    "to|towards|toward|into",
    40,
  ));
  scan(immediateTripPattern(travel.means, "to|towards|toward|into"));
  scan(verbPattern(travel.journeys, "to|towards|toward|into|for", 48));
  hits.sort((a, b) => a.index - b.index);
  return hits.at(-1)?.dest ?? null;
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

function knownPlace(state: State, dest: string): boolean {
  return Object.values(state.entities).some((entity) => entity.type === "place" && placeMatches(entity.name, entity.aliases, entity.id, dest));
}

function personNotPlace(state: State, dest: string): boolean {
  if (knownPlace(state, dest)) return false;
  return Object.values(state.entities).some(
    (entity) => entity.type === "person" && placeMatches(entity.name, entity.aliases, entity.id, dest),
  );
}

/** "Go back out to Connor" and "walk into town" are not trips. "Go to the kitchen" still is. */
function notADestination(state: State, dest: string): boolean {
  if (personNotPlace(state, dest)) return true;
  return VAGUE_DEST.has(norm(dest)) && !knownPlace(state, dest);
}

function checkTravel(before: State, after: State, config: Config, draft: TurnDraft, input: string, applied: Op[]): Violation[] {
  const dest = tripDestination(input, config);
  if (!dest || isLocalStep(dest, config.travel.local) || notADestination(before, dest)) return [];
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
    if (prev && tripDestination(prev.input, config) && isTravelRefusal(prev.narration)) {
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

/** The last word of a name, when no other item ends with it. "Cob" is the sausage cob. "Milk" is shared, so it is not. */
function uniqueNameTails(items: { id: string; name: string }[]): Map<string, string> {
  const owner = new Map<string, string>();
  const shared = new Set<string>();
  for (const item of items) {
    const tail = norm(item.name).split(" ").at(-1) ?? "";
    if (tail.length < 3) continue;
    if (shared.has(tail) || owner.has(tail)) {
      owner.delete(tail);
      shared.add(tail);
      continue;
    }
    owner.set(tail, item.id);
  }
  return owner;
}

function findMentions(narration: string, items: { id: string; name: string }[]): Mention[] {
  const text = narration.toLowerCase();
  const hits: Mention[] = [];
  const tails = uniqueNameTails(items);
  for (const item of items) {
    const phrases = new Set(itemPhrases(item));
    const tail = norm(item.name).split(" ").at(-1) ?? "";
    if (tails.get(tail) === item.id) phrases.add(tail);
    for (const phrase of phrases) {
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

function currencyKeys(config: Config): string[] {
  const keys = config.stats.filter((stat) => stat.type === "currency").map((stat) => stat.key);
  return keys.length > 0 ? keys : ["money"];
}

function spentMoney(ops: Op[], config: Config): boolean {
  const keys = new Set(currencyKeys(config));
  return ops.some((op) => op.op === "stat.add" && keys.has(op.key) && op.amount < 0);
}

interface Spend {
  amount: number;
  reason: string;
}

function currencySpends(ops: Op[], config: Config): Spend[] {
  const keys = new Set(currencyKeys(config));
  const out: Spend[] = [];
  for (const op of ops) {
    if (op.op === "stat.add" && keys.has(op.key) && op.amount < 0) out.push({ amount: op.amount, reason: op.reason ?? "" });
  }
  return out;
}

function addedQty(ops: Op[], playerId: string, itemId: string): number {
  let qty = 0;
  for (const op of ops) {
    if (op.op === "inventory.add" && op.owner === playerId && op.item === itemId) qty += op.qty;
  }
  return qty;
}

const QTY_WORD: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  hundred: 100,
};

/** The last explicit count in the words just before an item. One, when the player did not say. */
function wantedQty(window: string): number {
  let qty = 1;
  const re =
    /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|twenty|thirty|forty|fifty|sixty|hundred)\b/gi;
  for (const match of window.matchAll(re)) {
    const raw = match[0].toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : QTY_WORD[raw];
    if (n && n > 0 && n < 10000) qty = n;
  }
  return qty;
}

const ITEM_SKIP = new Set(["of", "the", "and", "for", "with", "from"]);

function contentTokens(item: { id: string; name: string }): string[] {
  return norm(`${item.name} ${item.id.replace(/[_-]/g, " ")}`)
    .split(" ")
    .filter((word) => word.length >= 3 && !ITEM_SKIP.has(word));
}

/**
 * One stretch of text names one item. "Pint of lager" is the lager, not the milk and the four-pack.
 * A shared word alone picks the item it names exactly, or the one with the fewest leftover words.
 */
function itemsInText<T extends { id: string; name: string }>(text: string, items: T[]): T[] {
  const mentions = findMentions(text, items);
  if (mentions.length > 0) {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const mention of mentions) {
      if (seen.has(mention.id)) continue;
      seen.add(mention.id);
      const item = items.find((candidate) => candidate.id === mention.id);
      if (item) out.push(item);
    }
    return out;
  }
  const hay = norm(text);
  if (!hay) return [];
  const scored = items
    .map((item) => {
      const tokens = contentTokens(item);
      const matched = tokens.filter((token) => hasWord(hay, token));
      return { item, matched: matched.length, unmatched: tokens.length - matched.length, exact: item.id.replace(/[_-]/g, " ") === hay || norm(item.name) === hay };
    })
    .filter((row) => row.matched > 0);
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.matched - a.matched || a.unmatched - b.unmatched || Number(b.exact) - Number(a.exact));
  const best = scored[0];
  if (!best) return [];
  const tied = scored.filter((row) => row.matched === best.matched && row.unmatched === best.unmatched);
  const exact = tied.filter((row) => row.exact || hasWord(hay, row.item.id.replace(/[_-]/g, " ")));
  const winner = exact.length === 1 ? exact[0] : tied[0];
  return winner ? [winner.item] : [];
}

interface Buy {
  id: string;
  name: string;
  price: number;
  wanted: number;
}

function noteBuy(buys: Map<string, Buy>, item: { id: string; name: string; price?: number }, wanted: number): void {
  if (item.price === undefined || item.price <= 0) return;
  const row = buys.get(item.id) ?? { id: item.id, name: item.name, price: item.price, wanted: 1 };
  row.wanted = Math.max(row.wanted, wanted);
  buys.set(item.id, row);
}

function removedItem(ops: Op[], playerId: string, itemId: string): boolean {
  return ops.some((op) => op.op === "inventory.remove" && op.owner === playerId && op.item === itemId);
}

function heldQty(state: State, playerId: string, itemId: string): number {
  const inv = state.modules.inventory as { owners?: Record<string, Record<string, number>> } | undefined;
  return inv?.owners?.[playerId]?.[itemId] ?? 0;
}

function alreadyOwned(name: string, id: string, held: number): Violation {
  return violation(
    "fixable",
    "already_owned",
    `The player already carries ${held} "${name}" (${id}). Mentioning it is not a new purchase. Do not inventory.add or charge it again unless they ask for another, or for more than they hold.`,
  );
}

function checkItems(before: State, after: State, config: Config, draft: TurnDraft, applied: Op[]): Violation[] {
  const catalog = catalogItems(config, after);
  if (catalog.length === 0) return [];
  const text = draft.narration.toLowerCase();
  const byId = new Map<string, { name: string; pay: boolean; release: boolean; wanted: number; again: boolean; consume: boolean; put: boolean; setDown: boolean }>();
  for (const mention of findMentions(draft.narration, catalog)) {
    const window = text.slice(Math.max(0, mention.start - 60), mention.start);
    const row = byId.get(mention.id) ?? {
      name: mention.name,
      pay: false,
      release: false,
      wanted: 1,
      again: false,
      consume: false,
      put: false,
      setDown: false,
    };
    const following = text.slice(mention.end, mention.end + 48);
    const pay = hasVerb(window, PAY);
    const parked = PARKED.test(following);
    const consume = hasVerb(window, RELEASE);
    const put = hasVerb(window, PUT_OR_LEAVE) && !parked;
    const setDown = hasVerb(window, SET_DOWN) && !parked;
    row.pay = row.pay || pay;
    row.consume = row.consume || consume;
    row.put = row.put || put;
    row.setDown = row.setDown || setDown;
    row.release = row.release || consume || put || setDown;
    row.again = row.again || ANOTHER.test(window);
    if (pay) row.wanted = Math.max(row.wanted, wantedQty(window));
    byId.set(mention.id, row);
  }
  const out: Violation[] = [];
  const buys = new Map<string, Buy>();
  const owned = new Set<string>();
  const player = config.player_id;
  for (const [id, row] of byId) {
    const item = catalog.find((candidate) => candidate.id === id);
    const gearSetDown = item?.keeps === true && row.setDown && !row.consume && !row.put;
    if (row.release && !gearSetDown && carrying(after, player, id) && !removedItem(applied, player, id)) {
      out.push(
        violation(
          "fixable",
          "item_still_held",
          `The narration has the player eat, drink, or put down "${row.name}" (${id}) but they still carry it. inventory.remove '${id}', or do not narrate letting it go.`,
        ),
      );
    }
    if (!row.pay || !item) continue;
    const held = heldQty(before, player, id);
    const fresh = row.again || row.wanted > held;
    if (!fresh && held >= 1) {
      if (addedQty(applied, player, id) > 0 && !owned.has(id)) {
        owned.add(id);
        out.push(alreadyOwned(row.name, id, held));
      }
      continue;
    }
    if (item.price === undefined || item.price <= 0) {
      if (!spentMoney(applied, config) || addedQty(applied, player, id) < 1) {
        out.push(
          violation(
            "fixable",
            "unpaid_item",
            `The narration buys or orders "${row.name}" (${id}) without both a payment and an inventory.add to the player. Add a negative stat.add and inventory.add of '${id}' with owner '${player}', or do not narrate the purchase.`,
          ),
        );
      }
      continue;
    }
    noteBuy(buys, item, row.wanted);
  }
  for (const spend of currencySpends(applied, config)) {
    for (const item of itemsInText(spend.reason, catalog)) {
      if (item.price === undefined || item.price <= 0) continue;
      const held = heldQty(before, player, item.id);
      if (held >= 1 && !ANOTHER.test(spend.reason)) {
        if (!owned.has(item.id)) {
          owned.add(item.id);
          out.push(alreadyOwned(item.name, item.id, held));
        }
        continue;
      }
      noteBuy(buys, item, 1);
    }
  }
  if (buys.size === 0) return out;
  const spends = currencySpends(applied, config);
  const totalSpent = spends.reduce((sum, spend) => sum + -spend.amount, 0);
  let due = 0;
  const missing: Buy[] = [];
  for (const buy of buys.values()) {
    const added = addedQty(applied, player, buy.id);
    due += buy.price * Math.max(buy.wanted, added, 1);
    if (added < 1) missing.push(buy);
  }
  const short = totalSpent + 0.001 < due;
  if (totalSpent > 0 && short) {
    const names = [...buys.values()].map((buy) => `${buy.name} (${buy.id}, ${buy.price} each)`).join(", ");
    out.push(
      violation(
        "fixable",
        "underpaid_item",
        `Spent ${totalSpent} on ${names}, which is not a whole number of catalog units (due ${due}). Charge a whole multiple of the price with stat.add and inventory.add to '${player}', or remove the spend and narrate that they cannot afford it.`,
      ),
    );
    return out;
  }
  for (const buy of missing) {
    out.push(
      violation(
        "fixable",
        "unpaid_item",
        `The narration buys or orders "${buy.name}" (${buy.id}) without both a payment and an inventory.add to the player. Add a negative stat.add of the catalog price (${buy.price}) and inventory.add of '${buy.id}' with owner '${player}', or do not narrate the purchase.`,
      ),
    );
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
    ...checkItems(before, after, config, draft, applied),
  ];
}
