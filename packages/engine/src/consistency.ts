import type { Config, Op, State, TurnDraft, Violation } from "@book/schema";
import { catalogItems } from "./catalog.ts";
import { playerLocation } from "./core.ts";
import { sharedContentWords } from "./threads.ts";

/**
 * A place name stops at the next clause. "the house and go into the kitchen" is two places,
 * and the last one is the kitchen. A comma is already outside this pattern.
 */
const DEST_STOP = "and|then|if|but|so|while|when|please|for|as|again|to";
const DEST = String.raw`(?:the\s+|a\s+|an\s+)?([a-z][a-z']*(?:\s+(?!${DEST_STOP}\b)[a-z][a-z']*){0,5})`;

/**
 * A refused trip says the player has not left. "Cerys is still at the table" is not that:
 * the word "still" there is about a person, and it must not hide a missing entity.move.
 */
const REFUSAL =
  /\b(?:haven't left|have not left|did not leave|didn't leave|not yet|there is no|there's no|you are still|you're still|can wait|hasn't happened|has not happened|you haven't|you have not|makes no sense|you need to sleep|need sleep)\b|\bno \w+ to leave\b/i;

const PAY =
  /\b(buy|bought|pay|paid|order|ordered|purchase|purchased|spend|spent)\b/gi;

/** The spend settles money owed rather than buying what it names. */
const REPAYS = /\b(?:pay(?:s|ing)? (?:\w+ )?back|paid (?:\w+ )?back|repay|repaid|repayment|owed?|loan|lent|borrowed|towards|my share|his share|her share|their share)\b/i;

/** Money changing hands without a pay verb: "hands over a tenner", "taps your card", "the till beeps". */
const SETTLES = /\b(?:hand(?:s|ed)? over|tap(?:s|ped)? (?:your|the|a) card|till|cashier|checkout|rings? (?:it|them|that|you) up|your change)\b/i;

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
  "chat",
  "check",
  "clean",
  "clear",
  "collect",
  "cut",
  "do",
  "drop",
  "eat",
  "find",
  "finish",
  "fix",
  "get",
  "give",
  "grab",
  "hand",
  "have",
  "help",
  "look",
  "make",
  "meet",
  "pay",
  "pick",
  "put",
  "read",
  "say",
  "see",
  "show",
  "sit",
  "sort",
  "speak",
  "start",
  "take",
  "talk",
  "tell",
  "text",
  "tidy",
  "try",
  "wait",
  "wash",
  "watch",
  "work",
]);

/** "Go to sleep" is rest, not a destination. "Go to bed" still is, once a bed exists. "To chase" is an infinitive. */
const NOT_A_PLACE = new Set(["sleep", "rest", "nap", "chase", "follow", "flee", "fight", "hide", "stay", "stop"]);

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

/**
 * The place ends where the company, the time, or the errand starts: "the house with Tomos",
 * "bed around eleven", "the pub tonight", "the shop for a cob" are the house, the bed, the pub, the shop.
 */
const DEST_TAIL =
  /\b(?:again|and|then|if|but|so|while|when|please|for|as|with|without|around|about|at|by|before|after|until|till|tonight|tomorrow|today|later|now|this|next|early|first|quickly|soon|once|via|instead|anyway)\b|\bto\b|\d/;

function cleanDestination(raw: string): string {
  const cut = raw.split(DEST_TAIL)[0] ?? raw;
  return norm(cut).replace(/^(?:the|a|an)\s+/, "");
}

/** A line that floats the trip as an idea for others: "suggest we go to the pub", "ask if they fancy the pub". */
const PROPOSAL =
  /\b(?:suggest|suggests|suggested|suggesting|propose|proposing|fancy|fancies|shall we|what about|how about|ask(?:s|ed|ing)? (?:if|whether)|see if|wonder(?:s|ed|ing)? (?:if|whether)|invite|offer(?:s|ed)? to|up for|anyone (?:want|fancy)|whether to|should we|maybe we)\b/i;

function isProposal(input: string, index: number): boolean {
  const clause = input.slice(0, index).split(/[.!?\n]/).pop() ?? "";
  return PROPOSAL.test(clause);
}

function isPlaceDestination(dest: string): boolean {
  const first = dest.split(" ")[0] ?? "";
  return dest.length >= 3 && !PURPOSE.has(first) && !NOT_A_PLACE.has(first);
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
  // The stretch from the verb to the preposition stays inside one action: "walk home and give Aisha
  // forty quid towards my sixty" is a walk, then a gift, so "and" and a comma end the stretch.
  return new RegExp(`\\b(?:${body})\\b(?:(?!\\b(?:and|then)\\b)[^.,;]){0,${span}}?\\b(?:${prepositions})\\s+${DEST}`, "gi");
}

interface DestHit {
  index: number;
  end: number;
  dest: string;
}

function destinationHits(input: string, config: Config): DestHit[] {
  const hits: DestHit[] = [];
  const scan = (pattern: RegExp | null) => {
    if (!pattern) return;
    const text = input.toLowerCase();
    for (const match of text.matchAll(pattern)) {
      const dest = cleanDestination(match[1] ?? "");
      if (match.index === undefined || isProposal(text, match.index)) continue;
      const end = match.index + match[0].length;
      if (tripNegated(text, match.index, end)) continue;
      if (isPlaceDestination(dest)) hits.push({ index: match.index, end, dest });
    }
  };
  const travel = config.travel;
  // toward/towards is a direction. Stopping on the way is arrival. Only to/into must land.
  scan(verbPattern(
    travel.means.filter((verb) => !departing(verb)),
    "to|into",
    40,
  ));
  scan(immediateTripPattern(travel.means, "to|into"));
  scan(verbPattern(travel.journeys, "to|into|for", 48));
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/** A prior clause that is itself the trip, so the last place of that journey still counts. */
function priorIsJourney(prior: string, config: Config): boolean {
  if (/\b(?:leave|left|head out|heading out|set off|go out|set a course|sail|walk out)\b/.test(prior)) return true;
  return destinationHits(prior, config).some((hit) => !deferredDestination(prior, config, hit));
}

/**
 * A later or conditional clause is not this turn's destination. "I'll go to Lidl" after
 * asking for cash, and "if I pass a shop", can wait. "I'll walk to Lidl" on its own cannot.
 */
function deferredDestination(input: string, config: Config, hit: DestHit): boolean {
  const text = input.toLowerCase();
  const before = text.slice(0, hit.index);
  const after = text.slice(hit.index, Math.min(text.length, hit.end + 48));
  if (/\bif\b/.test(after)) return true;
  const clauseStart = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
    before.lastIndexOf(";"),
  );
  if (/\bif\b/.test(before.slice(clauseStart + 1))) return true;
  const breakAt = Math.max(before.lastIndexOf(" then "), before.lastIndexOf(" and "), before.lastIndexOf(" but "));
  if (breakAt < 0) return false;
  const prior = before.slice(0, breakAt).trim();
  if (!prior || priorIsJourney(prior, config)) return false;
  return true;
}

function bindingHits(input: string, config: Config): DestHit[] {
  return destinationHits(input, config).filter((hit) => !deferredDestination(input, config, hit));
}

/** "Do not chase" and "too far to sail" are not trips. The negation has to sit on the verb, not later talk. */
function tripNegated(text: string, start: number, end: number): boolean {
  const window = text.slice(Math.max(0, start - 32), end);
  return /\b(?:not|never|too far|don't|do not|won't|cannot|can't)\b/i.test(window);
}

/** The last place the player asked to go to this turn, using this book's travel words. */
export function tripDestination(input: string, config: Config): string | null {
  return bindingHits(input, config).at(-1)?.dest ?? null;
}

export function isTravelRefusal(narration: string): boolean {
  return new RegExp(REFUSAL.source, "i").test(narration);
}

/** A tavern and a pub are the same kind of room when the rest of the name is the same place. */
const PLACE_KIND: Record<string, string> = { pub: "pub", tavern: "pub", inn: "pub", bar: "pub" };

function sameEstablishment(names: string[], needle: string): boolean {
  const destWords = needle.split(" ").filter((word) => word.length >= 3);
  return names.some((name) => {
    const words = name.split(" ").filter((word) => word.length >= 3);
    const shared = destWords.filter((word) => !PLACE_KIND[word] && word.length >= 4 && words.includes(word));
    if (shared.length === 0) return false;
    const rest = destWords.filter((word) => !shared.includes(word));
    const other = words.filter((word) => !shared.includes(word));
    return rest.every((word) => other.some((candidate) => candidate === word || (PLACE_KIND[candidate] !== undefined && PLACE_KIND[candidate] === PLACE_KIND[word])));
  });
}

function placeMatches(name: string, aliases: string[], id: string, dest: string): boolean {
  const needle = norm(dest);
  if (needle.length < 3) return false;
  const names = [name, ...aliases, id.replace(/[_-]/g, " ")].map(norm).filter((n) => n.length > 0);
  if (
    names.some((n) => {
      if (n === needle || hasWord(n, needle) || hasWord(needle, n)) return true;
      const words = n.split(" ");
      return needle.split(" ").every((part) => words.some((word) => wordCovers(word, part)));
    })
  ) {
    return true;
  }
  return sameEstablishment(names, needle);
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

/** The last place the player asked for is this one. */
export function matchesAskedPlace(state: State, config: Config, input: string, placeId: string): boolean {
  const place = state.entities[placeId];
  if (!place || place.type !== "place") return false;
  const last = bindingHits(input, config).at(-1);
  if (!last) return false;
  return placeMatches(place.name, place.aliases, place.id, last.dest);
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

/** "then head back inside", "and walk home", "come back": the trip ends where it started, not at the outing. */
const RETURN_LEG =
  /\b(?:head|heads|go|goes|get|gets|walk|walks|come|comes|run|runs|slip|slips|return|returns|make my way|make your way)\s+(?:straight\s+)?(?:back(?:\s+(?:home|inside|indoors|in|to the house))?|home|inside|indoors)\b(?!\s+(?:door|garden|room|seat|of|pocket|then|out))/i;

function returnLeg(input: string, afterIndex: number): string | null {
  const tail = input.slice(afterIndex);
  const match = RETURN_LEG.exec(tail);
  if (!match) return null;
  const word = match[0].toLowerCase();
  if (/\b(?:home|house)\b/.test(word)) return "home";
  if (/\b(?:inside|indoors|in)\b/.test(word)) return "inside";
  return "back";
}

function withinPlace(state: State, id: string | null, target: string): boolean {
  let current = id ? state.entities[id] : undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === target) return true;
    seen.add(current.id);
    current = current.location ? state.entities[current.location] : undefined;
  }
  return false;
}

function checkTravel(before: State, after: State, config: Config, draft: TurnDraft, input: string, applied: Op[]): Violation[] {
  const hits = bindingHits(input, config);
  const last = hits.at(-1);
  if (!last) return [];
  const back = returnLeg(input, last.end);
  if (back) {
    // The outing is not where they end up. "Home" or "inside" is checked against the place the book names for it.
    const target = Object.values(before.entities).find((e) => e.type === "place" && placeMatches(e.name, e.aliases, e.id, back));
    if (!target || back === "back") return [];
    const end = playerLocation(after, config);
    if (withinPlace(after, end, target.id) || isTravelRefusal(draft.narration)) return [];
    const here = end ? `${after.entities[end]?.name ?? end} [${end}]` : "nowhere";
    return [
      violation(
        "fixable",
        "arrived_elsewhere",
        `The player asked to come back ${back} after "${last.dest}" but the narration leaves them at ${here}. Set "at" to '${target.id}' or a place inside it, and entity.move the player there.`,
      ),
    ];
  }
  const missed = missedStop(before, after, config, draft, applied, last.dest, true);
  return missed ? [missed] : [];
}

function missedStop(
  before: State,
  after: State,
  config: Config,
  draft: TurnDraft,
  applied: Op[],
  dest: string,
  asked: boolean,
): Violation | null {
  if (isLocalStep(dest, config.travel.local) || notADestination(before, dest)) return null;
  const end = playerLocation(after, config);
  const endEntity = end ? after.entities[end] : undefined;
  const created = new Set<string>();
  for (const op of applied) {
    if (op.op === "entity.create" && op.type === "place") created.add(op.id);
  }
  if (endEntity && placeMatches(endEntity.name, endEntity.aliases, endEntity.id, dest)) return null;
  if (end && created.has(end) && !knownPlace(before, dest)) return null;
  if (isTravelRefusal(draft.narration)) {
    const prev = before.window.at(-1);
    if (prev && tripDestination(prev.input, config) && isTravelRefusal(prev.narration)) {
      return violation(
        "game_breaking",
        "trip_insisted",
        `The player already asked to leave and was refused. They asked again to go to "${dest}". Do not refuse twice: narrate the departure, entity.create the place if it does not exist, entity.move the player, and set "at" to that place id.`,
      );
    }
    return null;
  }
  const here = endEntity?.name ?? "the same place";
  const where = `${here}${end ? ` [${end}]` : ""}`;
  const lead = asked
    ? `The player asked to go to "${dest}" but the narration leaves them at ${where}.`
    : `The narration goes to "${dest}" but the player is at ${where}.`;
  return violation(
    "fixable",
    "arrived_elsewhere",
    `${lead} Narrate the arrival and set "at" to the place id. The engine creates that place only once the narration has arrived there. Do not invent a second id for the same place.`,
  );
}

function placeTitle(id: string): string {
  return id.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function isCreate(op: unknown, id: string): boolean {
  if (!op || typeof op !== "object") return false;
  const rec = op as { op?: unknown; id?: unknown; type?: unknown };
  return rec.op === "entity.create" && rec.id === id && (rec.type === undefined || rec.type === "place");
}

function isMove(op: unknown, id: string, location: string): boolean {
  if (!op || typeof op !== "object") return false;
  const rec = op as { op?: unknown; id?: unknown; location?: unknown };
  return rec.op === "entity.move" && rec.id === id && rec.location === location;
}

function playerAlreadyMoved(op: unknown, player: string): boolean {
  if (!op || typeof op !== "object") return false;
  const rec = op as { op?: unknown; id?: unknown };
  return rec.op === "entity.move" && rec.id === player;
}

/**
 * The GM is supposed to set `at`. When that field is empty, the player named one place
 * already on the sheet, and the reply is not a refusal, that sheet id is `at`.
 * Narration is not read. An unknown destination is left for the GM to create.
 * A move or an `at` the GM already wrote is left alone. A return leg is not the outing.
 */
function narrationMentionsPlace(narration: string, name: string, aliases: string[], id: string): boolean {
  const hay = norm(narration);
  const names = [name, ...aliases, id.replace(/[_-]+/g, " ")];
  return names.some((label) => {
    const needle = norm(label).replace(/^(?:the|a|an)\s+/, "");
    return needle.length >= 3 && hay.includes(needle);
  });
}

function narrationMentionsDest(narration: string, dest: string): boolean {
  const needle = norm(dest);
  if (needle.length < 3) return false;
  const hay = norm(narration);
  if (hay.includes(needle)) return true;
  const words = needle.split(" ").filter((word) => word.length >= 4);
  return words.length > 0 && words.every((word) => hay.includes(word));
}

/** One stable id from the player's destination words. The model is not asked to invent another. */
export function placeSlug(dest: string): string {
  const slug = norm(dest)
    .split(" ")
    .filter((word) => word.length > 0 && word !== "the" && word !== "a" && word !== "an")
    .join("-")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 64);
  return /^[a-z0-9]/.test(slug) ? slug : "";
}

function playerMoveIndex(delta: unknown[], player: string): number {
  return delta.findIndex((op) => playerAlreadyMoved(op, player));
}

/**
 * A move to an id the save does not have is retargeted onto one slug of the player's
 * destination, and that place is created, when the narration has arrived. A move the
 * narration never reaches is dropped, so the turn is not rejected for a missing id.
 */
export function retargetUnknownPlace(state: State, config: Config, draft: TurnDraft, input: string): void {
  const player = config.player_id;
  const index = playerMoveIndex(draft.delta, player);
  const hits = bindingHits(input, config);
  const last = hits.at(-1);
  const dropUnknown = (): void => {
    if (index < 0) return;
    const rec = asOp(draft.delta[index]);
    if (!rec || state.entities[String(rec.location)]) return;
    draft.delta.splice(index, 1);
  };
  if (!last || returnLeg(input, last.end) || notADestination(state, last.dest) || isTravelRefusal(draft.narration)) {
    dropUnknown();
    return;
  }
  const matches = Object.values(state.entities).filter(
    (entity) => entity.type === "place" && placeMatches(entity.name, entity.aliases, entity.id, last.dest),
  );
  const known = matches.length === 1 ? matches[0] : undefined;
  const slug = known?.id ?? placeSlug(last.dest);
  const mentioned = known
    ? narrationMentionsPlace(draft.narration, known.name, known.aliases, known.id)
    : narrationMentionsDest(draft.narration, last.dest);
  if (index < 0) return;
  const rec = asOp(draft.delta[index]);
  if (!rec || typeof rec.location !== "string" || state.entities[rec.location]) return;
  if (!mentioned || !slug) {
    draft.delta.splice(index, 1);
    return;
  }
  rec.location = slug;
  if (!state.entities[slug] && !draft.delta.some((op) => isCreate(op, slug))) {
    draft.delta.unshift({ op: "entity.create", id: slug, type: "place", name: placeTitle(slug) });
  }
  if (!draft.at) draft.at = slug;
}

function asOp(op: unknown): { location?: unknown } | null {
  return op && typeof op === "object" ? (op as { location?: unknown }) : null;
}

const ARRIVED =
  /\b(?:head|heads|go|goes|step|steps|slip|slips|walk|walks|come|comes|climb|climbs|wander|wanders|hurry|hurries|run|runs|drift|drifts|trudge|trudges|pad|pads|sail|sails|enter|enters|reach|reaches|arrive|arrives)\b/i;

/** The sentence has them moving, and it does not sit them in some other known place. */
function proseArrived(state: State, narration: string, dest: string): boolean {
  if (!ARRIVED.test(narration)) return false;
  return !Object.values(state.entities).some(
    (entity) =>
      entity.type === "place" &&
      !placeMatches(entity.name, entity.aliases, entity.id, dest) &&
      narrationMentionsPlace(narration, entity.name, entity.aliases, entity.id) &&
      /\byou\b/i.test(narration),
  );
}

export function fillOrderedAt(state: State, config: Config, draft: TurnDraft, input: string): void {
  if (draft.at || input.trim().length === 0 || isTravelRefusal(draft.narration)) return;
  const player = config.player_id;
  if (draft.delta.some((op) => playerAlreadyMoved(op, player))) return;
  const hits = bindingHits(input, config);
  const last = hits.at(-1);
  if (!last || returnLeg(input, last.end)) return;
  if (notADestination(state, last.dest)) return;
  const matches = Object.values(state.entities).filter(
    (entity) => entity.type === "place" && placeMatches(entity.name, entity.aliases, entity.id, last.dest),
  );
  if (matches.length === 1 && matches[0]) {
    const place = matches[0];
    const mentioned = narrationMentionsPlace(draft.narration, place.name, place.aliases, place.id);
    if (mentioned || proseArrived(state, draft.narration, last.dest)) draft.at = place.id;
    return;
  }
  if (matches.length > 0) return;
  if (!narrationMentionsDest(draft.narration, last.dest)) return;
  const slug = placeSlug(last.dest);
  if (!slug || (state.entities[slug] && state.entities[slug]?.type !== "place")) return;
  draft.at = slug;
}

/**
 * The GM sets `at` to the place the player is in. The engine creates that place when it is new
 * and moves the player there on this turn. Narration verbs are not how a move is detected.
 */
export function materializeAt(state: State, config: Config, draft: TurnDraft): void {
  const id = draft.at;
  if (!id) return;
  const known = state.entities[id];
  if (known && known.type !== "place") return;
  const delta = draft.delta;
  if (!known && !delta.some((op) => isCreate(op, id))) {
    delta.unshift({ op: "entity.create", id, type: "place", name: placeTitle(id) });
  }
  const player = config.player_id;
  if (!delta.some((op) => isMove(op, player, id)) && state.entities[player]?.location !== id) {
    delta.push({ op: "entity.move", id: player, location: id });
  }
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

/**
 * Words that can sit beside an item without becoming part of its name.
 * "The cob" is the cob. "Quiet corner" and "coffee table" are not.
 */
const NEAR_WORD = new Set([
  "the",
  "a",
  "an",
  "my",
  "your",
  "his",
  "her",
  "their",
  "our",
  "this",
  "that",
  "some",
  "of",
  "and",
  "for",
  "with",
  "from",
  "to",
  "on",
  "in",
  "at",
  "it",
  "up",
  "down",
  "away",
  "out",
  "off",
  "over",
  "back",
  "here",
  "there",
  "now",
  "too",
  "aside",
]);

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

function wordBeside(text: string, index: number, direction: -1 | 1): string {
  const slice = direction < 0 ? text.slice(0, index) : text.slice(index);
  const match = direction < 0 ? /([a-z][a-z']*)\W*$/i.exec(slice) : /^\W*([a-z][a-z']*)/i.exec(slice);
  return match?.[1]?.toLowerCase() ?? "";
}

function nameWords(name: string): Set<string> {
  return new Set(norm(name).split(" ").filter(Boolean));
}

function besideOk(word: string, words: Set<string>): boolean {
  return word.length === 0 || NEAR_WORD.has(word) || words.has(word);
}

/** A single word of the name does not continue into a different noun: "coffee table". */
function followingFits(text: string, end: number, name: string): boolean {
  return besideOk(wordBeside(text, end, 1), nameWords(name));
}

/** "Cracked corner" is the phone. "Quiet corner" is not. "The cob" still is. */
function tailFits(text: string, start: number, end: number, name: string): boolean {
  const words = nameWords(name);
  return besideOk(wordBeside(text, start, -1), words) && besideOk(wordBeside(text, end, 1), words);
}

/** "Lager" is the pint's last word and the start of "lager 4-pack". The longer good wins. */
function longerItemCovers(
  text: string,
  start: number,
  end: number,
  tail: string,
  itemId: string,
  items: { id: string; name: string }[],
): boolean {
  const window = text.slice(Math.max(0, start - 32), Math.min(text.length, end + 32));
  for (const item of items) {
    if (item.id === itemId) continue;
    const forms = [norm(item.name), norm(item.id.replace(/[_-]/g, " "))];
    for (const phrase of forms) {
      if (phrase.length <= tail.length || !phrase.split(" ").includes(tail)) continue;
      const flex = phrase.split(" ").map(escapeRegExp).join("[\\s-]+");
      if (new RegExp(`\\b${flex}\\b`, "i").test(window)) return true;
    }
  }
  return false;
}

function findMentions(narration: string, items: { id: string; name: string }[]): Mention[] {
  const text = narration.toLowerCase();
  const hits: Mention[] = [];
  const tails = uniqueNameTails(items);
  for (const item of items) {
    for (const phrase of itemPhrases(item)) {
      const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "g");
      const single = !phrase.includes(" ");
      for (const match of text.matchAll(re)) {
        if (match.index === undefined) continue;
        const start = match.index;
        const end = start + phrase.length;
        if (single && !followingFits(text, end, item.name)) continue;
        hits.push({ id: item.id, name: item.name, start, end, phrase });
      }
    }
    const tail = norm(item.name).split(" ").at(-1) ?? "";
    if (tails.get(tail) !== item.id) continue;
    const re = new RegExp(`\\b${escapeRegExp(tail)}\\b`, "g");
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      const start = match.index;
      const end = start + tail.length;
      if (!tailFits(text, start, end, item.name)) continue;
      if (longerItemCovers(text, start, end, tail, item.id, items)) continue;
      hits.push({ id: item.id, name: item.name, start, end, phrase: tail });
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
    // "in working order" and "in order" are not a purchase.
    if ((word === "order" || word === "ordered") && /\b(?:in|working|mail)\s+$/i.test(before)) continue;
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

/** The last explicit count in the words just before an item. One, when the player did not say. A price such as £2.50 is not a count. */
function wantedQty(window: string): number {
  let qty = 1;
  const re =
    /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|twenty|thirty|forty|fifty|sixty|hundred)\b/gi;
  for (const match of window.matchAll(re)) {
    const raw = match[0].toLowerCase();
    const at = match.index ?? 0;
    if (/^\d+$/.test(raw) && (window[at - 1] === "." || window[at + raw.length] === ".")) continue;
    const n = /^\d+$/.test(raw) ? Number(raw) : QTY_WORD[raw];
    if (n && n > 0 && n < 10000) qty = n;
  }
  return qty;
}

/** The verb has to sit in the same sentence as the item, and close to it. The line above does not count. */
function clauseBefore(text: string, start: number): string {
  const prior = text.slice(0, start);
  const sentence = prior.split(/[.!?\n]/).pop() ?? prior;
  return sentence.slice(-40);
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

/**
 * The money covers a leading run of the goods, each at a whole catalog price, and stops.
 * Later goods the bag did not receive are left out of the bill instead of failing the turn.
 */
function affordablePrefix(ordered: Buy[], totalSpent: number, narration: string): Buy[] | null {
  const hay = narration.toLowerCase();
  const sorted = [...ordered].sort((a, b) => {
    const ia = hay.indexOf(a.name.toLowerCase());
    const ib = hay.indexOf(b.name.toLowerCase());
    return (ia < 0 ? 1_000_000 : ia) - (ib < 0 ? 1_000_000 : ib);
  });
  let sum = 0;
  const kept: Buy[] = [];
  for (const buy of sorted) {
    const next = sum + buy.price * Math.max(buy.wanted, 1);
    if (next > totalSpent + 0.001) break;
    sum = next;
    kept.push(buy);
  }
  if (kept.length === 0 || kept.length === sorted.length) return null;
  if (Math.abs(sum - totalSpent) > 0.001) return null;
  return kept;
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

/**
 * Gear is still held unless the verb sits on that item in the same short clause.
 * "Mop the floor" must not fail because a phone is also in the paragraph.
 */
function keptItemLetGo(narration: string, itemId: string, itemName: string): boolean {
  const text = narration.toLowerCase();
  const phrases = [norm(itemName), norm(itemId.replace(/[_-]/g, " "))].filter((phrase) => phrase.length >= 3);
  for (const phrase of phrases) {
    const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "g");
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      const prior = text.slice(Math.max(0, match.index - 48), match.index);
      const clause = prior.split(/[.!?\n;,]|\band\b|\bthen\b/).pop() ?? "";
      const window = clause.slice(-32);
      const following = text.slice(match.index + phrase.length, match.index + phrase.length + 24);
      if (PARKED.test(following)) continue;
      if (hasVerb(window, RELEASE) || hasVerb(window, PUT_OR_LEAVE) || (hasVerb(window, SET_DOWN) && !PARKED.test(window))) return true;
    }
  }
  return false;
}

function checkItems(before: State, after: State, config: Config, draft: TurnDraft, applied: Op[], input = ""): Violation[] {
  const catalog = catalogItems(config, after);
  if (catalog.length === 0) return [];
  const text = draft.narration.toLowerCase();
  const byId = new Map<string, { name: string; pay: boolean; release: boolean; wanted: number; again: boolean; consume: boolean; put: boolean; setDown: boolean }>();
  for (const mention of findMentions(draft.narration, catalog)) {
    const window = clauseBefore(text, mention.start);
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
    const gear = item?.keeps === true;
    const gearSetDown = gear && row.setDown && !row.consume && !row.put;
    const gearLetGo = !gear || keptItemLetGo(draft.narration, id, row.name);
    if (row.release && !gearSetDown && gearLetGo && carrying(after, player, id) && !removedItem(applied, player, id)) {
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
    if (item.keeps === true && held >= 1 && !row.again) {
      if (addedQty(applied, player, id) > 0 && !owned.has(id)) {
        owned.add(id);
        out.push(alreadyOwned(row.name, id, held));
      }
      continue;
    }
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
    // "£28 to Aisha for the textbook" settles a debt; the textbook is the reason, not the purchase.
    if (REPAYS.test(spend.reason)) continue;
    for (const item of itemsInText(spend.reason, catalog)) {
      const row = byId.get(item.id);
      const held = heldQty(before, player, item.id);
      if (held >= 1 && !ANOTHER.test(spend.reason) && !ANOTHER.test(draft.narration)) {
        if (!owned.has(item.id)) {
          owned.add(item.id);
          out.push(alreadyOwned(item.name, item.id, held));
        }
        continue;
      }
      if (item.price === undefined || item.price <= 0) continue;
      // Pouring Owen's milk is not buying milk: a charge needs a purchase somewhere in the turn, or the figure.
      if (!row?.pay && !hasVerb(text, PAY) && !SETTLES.test(text) && !hasVerb(input.toLowerCase(), PAY) && !mentionsAmount(draft.narration, spend.amount)) {
        out.push(
          violation(
            "fixable",
            "unstated_charge",
            `The delta charges ${-spend.amount} for "${item.name}" (${item.id}) but the narration never buys, pays for, or orders it. Remove that stat.add and any inventory.add of '${item.id}', or narrate the purchase.`,
          ),
        );
        continue;
      }
      noteBuy(buys, item, 1);
    }
  }
  // A price quote is not a second copy. Paying, or asking for another, still is.
  for (const op of applied) {
    if (op.op !== "inventory.add" || op.owner !== player || owned.has(op.item)) continue;
    const held = heldQty(before, player, op.item);
    if (held < 1 || ANOTHER.test(draft.narration)) continue;
    const row = byId.get(op.item);
    if (row?.pay || row?.again) continue;
    const item = catalog.find((candidate) => candidate.id === op.item);
    if (!item) continue;
    owned.add(op.item);
    out.push(alreadyOwned(item.name, op.item, held));
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
    const ordered = [...buys.values()];
    const prefix = affordablePrefix(ordered, totalSpent, draft.narration);
    const dropped = prefix === null ? [] : ordered.filter((buy) => !prefix.includes(buy));
    const keptWhole = prefix !== null && dropped.every((buy) => addedQty(applied, player, buy.id) < 1);
    if (keptWhole && prefix) {
      for (const buy of dropped) buys.delete(buy.id);
      missing.length = 0;
      for (const buy of buys.values()) {
        if (addedQty(applied, player, buy.id) < 1) missing.push(buy);
      }
    } else {
      const names = ordered.map((buy) => `${buy.name} (${buy.id}, ${buy.price} each)`).join(", ");
      out.push(
        violation(
          "fixable",
          "underpaid_item",
          `Spent ${totalSpent} on ${names}, which is not a whole number of catalog units (due ${due}). Charge a whole multiple of the price with stat.add and inventory.add to '${player}', or remove the spend and narrate that they cannot afford it.`,
        ),
      );
      return out;
    }
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

const PLAN_TIME =
  /\b(?:for|until|till|before|after|alarm|deadline|due|from|sent|timestamped|stamped|received|arrived|opens?|closes?|starts?|ends?|leaves?|departs?|arrives?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|yesterday|earlier|later|next|last)\s+(?:(?:the|a|an)\s+)?(?:at\s+)?(?:about\s+|around\s+|roughly\s+)?$/i;

/** A sentence about a plan, a day, or a message: the time in it is not the clock unless it says so. */
const NOT_NOW = /\b(?:tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|interview|appointment|meeting|booked|deadline|inspection|lecture|lectures|alarm|quiz|text|texts|message|notification|timestamp|timestamped|sent|reply|replied)\b/i;
const IS_MESSAGE = /\b(?:text|texts|message|notification|timestamp|timestamped|sent|reply|replied)\b/i;
const CLOCK_NOW_HINT = /\b(?:now|it's|it is|reads?|shows|(?<!o')clock|watch)\b/i;

/** The sentence a match sits in, so a quoted text message or a plan is judged as a whole. */
function sentenceAround(text: string, index: number): string {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"));
  const rest = text.slice(index);
  const stop = rest.search(/[.!?\n]/);
  return text.slice(start + 1, stop < 0 ? text.length : index + stop);
}

/** The match sits inside quotation marks: a message or something somebody said. */
function insideQuotes(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const singles = (before.match(/(?<![a-z])'|'(?![a-z])/gi) ?? []).length;
  const doubles = (before.match(/["\u201c\u201d]/g) ?? []).length;
  return singles % 2 === 1 || doubles % 2 === 1;
}

/** The time is the clock of the scene: not a plan, not a message stamp, not somebody's quoted words. */
function clockStatesNow(narration: string, index: number): boolean {
  const before = narration.slice(Math.max(0, index - 24), index);
  if (PLAN_TIME.test(before) || /\u00a3\s*$/.test(before)) return false;
  if (insideQuotes(narration, index)) return false;
  const sentence = sentenceAround(narration, index);
  if (NOT_NOW.test(sentence)) return CLOCK_NOW_HINT.test(sentence) && !IS_MESSAGE.test(sentence);
  return true;
}

const HOUR_WORD: Record<string, number> = {
  one: 1,
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
  midday: 12,
  noon: 12,
  midnight: 0,
};

const SPOKEN_CLOCK =
  /\b(?:(half|quarter)\s+(?:(past|to)\s+)?)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|midday|noon|midnight|\d{1,2})(\s*o'?clock)?(?:\s+in the (morning|afternoon|evening))?\b/gi;

function spokenToFace(match: RegExpMatchArray, nowHours: number | undefined): { hours: number; minutes: number } | null {
  const word = (match[3] ?? "").toLowerCase();
  let hours = /^\d+$/.test(word) ? Number(word) : HOUR_WORD[word];
  if (hours === undefined || hours > 23) return null;
  let minutes = 0;
  const fraction = (match[1] ?? "").toLowerCase();
  const direction = (match[2] ?? "").toLowerCase();
  if (fraction === "quarter" && !direction) return null;
  if (fraction) {
    minutes = fraction === "half" ? 30 : 15;
    if (direction === "to") {
      hours = (hours + 23) % 24;
      minutes = 60 - minutes;
    }
  }
  const part = (match[5] ?? "").toLowerCase();
  if (hours >= 1 && hours < 12) {
    if (part === "afternoon" || part === "evening") hours += 12;
    else if (part === "" && nowHours !== undefined) {
      // No half of the day named: the reading nearer the clock wins, so "half seven" at 09:00 is the morning.
      const gap = (face: number) => Math.min(Math.abs(face - nowHours), 24 - Math.abs(face - nowHours));
      if (gap(hours + 12) < gap(hours)) hours += 12;
    }
  }
  return { hours, minutes };
}

/**
 * "By six o'clock", "half seven", "quarter to nine" are clock times too. Only a form with
 * "o'clock", "half", or "quarter" is read, so "two essays" and "three quid" stay numbers.
 * The current clock decides morning or afternoon when the sentence does not.
 */
function spokenClock(narration: string, now: string): { hours: number; minutes: number } | null {
  let found: { hours: number; minutes: number } | null = null;
  const face = clockFace(now);
  for (const match of narration.matchAll(SPOKEN_CLOCK)) {
    if (match.index === undefined || (!match[1] && !match[4])) continue;
    if (!clockStatesNow(narration, match.index)) continue;
    const parsed = spokenToFace(match, face?.hours);
    if (parsed) found = parsed;
  }
  return found;
}

/**
 * The last clock time the narration states as now. "Alarm for 08:00" is a plan, "sent at 08:47"
 * is a stamp, "Tuesday 14:30 work?" is an appointment, and a time inside a text is quoted.
 */
function statedClock(narration: string, now: string): { hours: number; minutes: number } | null {
  let found: { hours: number; minutes: number } | null = null;
  for (const match of narration.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59 || match.index === undefined) continue;
    if (!clockStatesNow(narration, match.index)) continue;
    found = { hours, minutes };
  }
  return found ?? spokenClock(narration, now);
}

function clockFace(iso: string): { hours: number; minutes: number } | null {
  const match = /T(\d{2}):(\d{2})$/.exec(iso);
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/** Signed minutes from the clock face to the stated face. Negative means that time is already past today. */
function minutesUntil(from: string, hours: number, minutes: number): number {
  const face = clockFace(from);
  if (!face) return -1;
  return hours * 60 + minutes - (face.hours * 60 + face.minutes);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function checkClock(before: State, after: State, config: Config, draft: TurnDraft): Violation[] {
  const stated = statedClock(draft.narration, before.clock.now);
  const landed = clockFace(after.clock.now);
  const began = clockFace(before.clock.now);
  if (!stated || !landed) return [];
  if (stated.hours === landed.hours && stated.minutes === landed.minutes) return [];
  // "Your phone shows 08:00 when you wake" describes the start of the turn; the minutes after it are the delta's.
  if (began && stated.hours === began.hours && stated.minutes === began.minutes) return [];
  const label = `${pad(stated.hours)}:${pad(stated.minutes)}`;
  const now = `${pad(landed.hours)}:${pad(landed.minutes)}`;
  const mins = minutesUntil(before.clock.now, stated.hours, stated.minutes);
  const cap = Math.max(config.time.max_skip_minutes, config.time.max_per_turn);
  const date = before.clock.now.slice(0, 10);
  // A face earlier than the clock is a stamp (a missed call, a quote). Do not tell the
  // model to clock.set backwards. A draft that itself contains clock.set may still go back.
  if (mins < 0) return [];
  let exact: string;
  if (mins === 0) {
    exact = ` The clock was already ${label}. Leave it there, or name the other time and put it in the delta.`;
  } else if (mins > 0 && mins <= cap) {
    exact = ` From ${before.clock.now.slice(11)}, clock.advance ${mins} minutes lands on ${label}.`;
  } else {
    exact = ` clock.set {"now":"${date}T${label}"} lands on ${label}.`;
  }
  return [
    violation(
      "fixable",
      "clock_mismatch",
      `The narration says ${label} but the clock is ${now}.${exact} Put that exact number in the delta.`,
    ),
  ];
}

/**
 * A face the narration states as now, inside the turn limit, is the clock.
 * An advance that overshoots or falls short is rewritten. A time already past, a plan,
 * and a clock.set that goes backward are left alone.
 */
export function snapStatedClock(state: State, config: Config, draft: TurnDraft): void {
  const stated = statedClock(draft.narration, state.clock.now);
  const began = clockFace(state.clock.now);
  if (!stated || !began) return;
  if (stated.hours === began.hours && stated.minutes === began.minutes) return;
  const mins = minutesUntil(state.clock.now, stated.hours, stated.minutes);
  if (mins <= 0) return;
  const scene = config.time.max_per_turn;
  const skip = config.time.max_skip_minutes;
  if (mins > scene && (skip <= 0 || mins > skip)) return;
  const backward = draft.delta.some((op) => {
    if (!op || typeof op !== "object") return false;
    const rec = op as { op?: unknown; now?: unknown };
    return rec.op === "clock.set" && typeof rec.now === "string" && rec.now < state.clock.now;
  });
  if (backward) return;
  const clockOp =
    mins <= scene
      ? { op: "clock.advance", minutes: mins }
      : { op: "clock.skip", minutes: mins, reason: "the narration's clock" };
  let placed = false;
  const next: unknown[] = [];
  for (const op of draft.delta) {
    const rec = op && typeof op === "object" ? (op as { op?: unknown }) : null;
    if (rec && (rec.op === "clock.advance" || rec.op === "clock.skip" || rec.op === "clock.set")) {
      if (!placed) {
        next.push(clockOp);
        placed = true;
      }
      continue;
    }
    next.push(op);
  }
  if (!placed) next.push(clockOp);
  draft.delta = next;
}

/** A negative currency change. */
function asCharge(op: unknown, keys: Set<string>): { key: string; amount: number } | null {
  if (!op || typeof op !== "object") return null;
  const rec = op as { op?: unknown; key?: unknown; amount?: unknown };
  if (rec.op !== "stat.add" || typeof rec.key !== "string" || typeof rec.amount !== "number") return null;
  if (!keys.has(rec.key) || !(rec.amount < 0)) return null;
  return { key: rec.key, amount: rec.amount };
}

function mentionsAmount(narration: string, amount: number): boolean {
  const abs = Math.abs(amount);
  if (!Number.isFinite(abs) || abs === 0) return false;
  if (spokenAmount(narration, abs)) return true;
  // A range is a quote, not a handoff: "£5–10" does not state a charge of 5 or of 10.
  const hay = narration.replace(/,/g, "").replace(/£?\s*\d+(?:\.\d+)?\s*(?:–|—|-|to)\s*£?\s*\d+(?:\.\d+)?/gi, " ");
  const forms = new Set([String(abs), abs.toFixed(2)]);
  for (const form of forms) {
    const body = form.replace(".", "\\.");
    if (new RegExp(`(?:£\\s*)?${body}\\b`).test(hay)) return true;
  }
  return false;
}

/** Haggling that names the price in words still states the charge. */
function spokenAmount(narration: string, amount: number): boolean {
  const hay = narration.toLowerCase();
  if (amount === 10 && /\b(?:tenner|tenners|ten)\b/.test(hay)) return true;
  if (amount === 38 && /\bthirty[-\s]?eight\b/.test(hay)) return true;
  return false;
}

/** The narration told the player this cost nothing, so the engine balance stays. */
function saysFree(narration: string): boolean {
  return (
    /\b(?:costs?|costing)\s+nothing\b/i.test(narration) ||
    /\b(?:for free|free of charge|no charge|without paying)\b/i.test(narration) ||
    /\b(?:didn't|did not|doesn't|does not)\s+cost\b/i.test(narration)
  );
}

function chargeKeys(config: Config): Set<string> {
  return new Set(config.stats.filter((stat) => stat.type === "currency").map((stat) => stat.key));
}

function checkNarratedCharge(config: Config, draft: TurnDraft, applied: Op[]): Violation[] {
  if (!saysFree(draft.narration)) return [];
  const keys = chargeKeys(config);
  const hit = applied.map((op) => asCharge(op, keys)).filter((op): op is { key: string; amount: number } => op !== null);
  if (hit.length === 0) return [];
  const which = [...new Set(hit.map((item) => item.key))].join(", ");
  return [
    violation(
      "fixable",
      "free_charge",
      `The narration says this cost nothing. Remove the negative stat.add on ${which} so the engine keeps that balance.`,
    ),
  ];
}

/**
 * A repair may fix a move or a clock. It may not add a charge the narration never stated
 * and the original delta never contained. A narration that says the cost was nothing drops the charge.
 */
function asInventoryAdd(op: unknown): { owner: string; item: string } | null {
  if (!op || typeof op !== "object") return null;
  const rec = op as { op?: unknown; owner?: unknown; item?: unknown };
  if (rec.op !== "inventory.add" || typeof rec.owner !== "string" || typeof rec.item !== "string") return null;
  return { owner: rec.owner, item: rec.item };
}

function chargeReason(op: unknown): string {
  if (!op || typeof op !== "object") return "";
  const reason = (op as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "";
}

/**
 * A repair may fix a move or a clock. It may not add a charge the narration never stated
 * and the original delta never contained. A narration that says the cost was nothing drops the charge.
 * A price range is not that statement. An inventory.add that arrived with the dropped charge goes too.
 */
export function dropInventedCharges(original: unknown[], next: unknown[], narration: string, config: Config): unknown[] {
  const keys = chargeKeys(config);
  if (keys.size === 0) return next;
  const prior = original.map((op) => asCharge(op, keys)).filter((op): op is { key: string; amount: number } => op !== null);
  const priorAdds = original.map(asInventoryAdd).filter((op): op is { owner: string; item: string } => op !== null);
  const keepCharge = (op: unknown): boolean => {
    const charge = asCharge(op, keys);
    if (!charge) return true;
    if (saysFree(narration)) return false;
    if (prior.some((item) => item.key === charge.key && Math.abs(item.amount - charge.amount) < 0.001)) return true;
    return mentionsAmount(narration, charge.amount);
  };
  const droppedReasons = next.filter((op) => asCharge(op, keys) && !keepCharge(op)).map(chargeReason);
  return next.filter((op) => {
    if (asCharge(op, keys)) return keepCharge(op);
    const add = asInventoryAdd(op);
    if (!add || droppedReasons.length === 0) return true;
    if (priorAdds.some((item) => item.owner === add.owner && item.item === add.item)) return true;
    const label = add.item.replace(/[_-]/g, " ");
    return !droppedReasons.some((reason) => sharedContentWords(label, reason) >= 1);
  });
}

/**
 * Catalog goods a charge names when the narration and the input never buy, pay, or state the figure.
 * The same test as `unstated_charge`, so a turn can drop those ops and commit.
 */
export function unstatedItemIds(state: State, config: Config, narration: string, input: string, delta: unknown[]): Set<string> {
  const catalog = catalogItems(config, state);
  const out = new Set<string>();
  if (catalog.length === 0) return out;
  const text = narration.toLowerCase();
  const stated = hasVerb(text, PAY) || SETTLES.test(text) || hasVerb(input.toLowerCase(), PAY);
  for (const op of delta) {
    if (!op || typeof op !== "object") continue;
    const rec = op as { op?: unknown; key?: unknown; amount?: unknown; reason?: unknown };
    if (rec.op !== "stat.add" || typeof rec.key !== "string" || typeof rec.amount !== "number" || !(rec.amount < 0)) continue;
    if (!chargeKeys(config).has(rec.key)) continue;
    const reason = typeof rec.reason === "string" ? rec.reason : "";
    if (REPAYS.test(reason)) continue;
    if (stated || mentionsAmount(narration, rec.amount)) continue;
    for (const item of itemsInText(reason, catalog)) {
      if (item.price === undefined || item.price <= 0) continue;
      out.add(item.id);
    }
  }
  return out;
}

/** Checks that run after a legal delta: place, travel, clock, and catalog items. They do not invent ops. */
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
    ...checkClock(before, after, config, draft),
    ...checkNarratedCharge(config, draft, applied),
    ...checkItems(before, after, config, draft, applied, input),
  ];
}
