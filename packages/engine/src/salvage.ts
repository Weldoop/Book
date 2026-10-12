import type { Config, Entity, State, TurnDraft } from "@book/schema";
import { catalogItems } from "./catalog.ts";
import { unstatedItemIds } from "./consistency.ts";
import { sharedContentWords } from "./threads.ts";

type Rec = Record<string, unknown>;

const ANOTHER = /\b(?:another|one more|a second|extra)\b/i;
const BROUGHT =
  /\b(?:bring|brings|brought|with you|with me|comes? (?:in|over|round|home|along|back)|came (?:in|over|round|home|along|back)|lets? (?:her|him|them) in|at the door|walks? (?:in|over|home)|comes? with)\b/i;

function asRec(op: unknown): Rec | null {
  return op && typeof op === "object" && !Array.isArray(op) ? (op as Rec) : null;
}

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

function currencyKeys(config: Config): Set<string> {
  return new Set(config.stats.filter((stat) => stat.type === "currency").map((stat) => stat.key));
}

function heldQty(state: State, playerId: string, itemId: string): number {
  const inv = state.modules.inventory as { owners?: Record<string, Record<string, number>> } | undefined;
  return inv?.owners?.[playerId]?.[itemId] ?? 0;
}

function reasonNamesItem(reason: string, item: { id: string; name: string }): boolean {
  const hay = norm(reason);
  if (!hay) return false;
  const name = norm(item.name);
  const id = norm(item.id.replace(/[_-]/g, " "));
  if (name.length >= 3 && hay.includes(name)) return true;
  if (id.length >= 3 && hay.includes(id)) return true;
  const tokens = name.split(" ").filter((word) => word.length >= 4);
  return tokens.length > 0 && tokens.every((word) => hay.includes(word));
}

/**
 * A charge the narration never buys, and a second copy of gear already in the bag,
 * come out of the delta. The turn can commit. A price the narration does state stays.
 */
export function salvageBookkeeping(state: State, config: Config, draft: TurnDraft, input: string): void {
  const catalog = catalogItems(config, state);
  const keys = currencyKeys(config);
  const player = config.player_id;
  const narration = draft.narration;
  const unstated = unstatedItemIds(state, config, narration, input, draft.delta);
  const dropAdds = new Set(unstated);

  for (const op of draft.delta) {
    const rec = asRec(op);
    if (!rec || rec.op !== "inventory.add" || rec.owner !== player || typeof rec.item !== "string") continue;
    const item = catalog.find((candidate) => candidate.id === rec.item);
    if (!item?.keeps) continue;
    if (heldQty(state, player, item.id) < 1) continue;
    if (ANOTHER.test(narration) || ANOTHER.test(input)) continue;
    dropAdds.add(item.id);
  }

  if (dropAdds.size === 0) return;
  draft.delta = draft.delta.filter((op) => {
    const rec = asRec(op);
    if (!rec) return true;
    if (rec.op === "inventory.add" && typeof rec.item === "string" && dropAdds.has(rec.item)) return false;
    if (rec.op === "stat.add" && typeof rec.key === "string" && keys.has(rec.key) && typeof rec.amount === "number" && rec.amount < 0) {
      const reason = typeof rec.reason === "string" ? rec.reason : "";
      const named = catalog.some((item) => unstated.has(item.id) && reasonNamesItem(reason, item));
      if (named) return false;
    }
    return true;
  });
}

function playerQuotes(input: string): string[] {
  const out: string[] = [];
  for (const match of input.matchAll(/["“]([^"”\n]{8,})["”]/g)) {
    const text = match[1]?.trim();
    if (text) out.push(text);
  }
  return out;
}

/** A quoted sentence from the player is copied into the narration. A rewritten quote is replaced. */
export function protectQuotes(draft: TurnDraft, input: string): void {
  const wanted = playerQuotes(input);
  if (wanted.length === 0) return;
  let narration = draft.narration;
  for (const quote of wanted) {
    if (narration.includes(quote)) continue;
    const slots = [...narration.matchAll(/["“]([^"”\n]{0,400})["”]/g)];
    const fuzzy = slots.find((slot) => slot[1] && sharedContentWords(slot[1], quote) >= 2);
    if (fuzzy?.[0]) narration = narration.replace(fuzzy[0], `"${quote}"`);
    else narration = `${narration.trim()} "${quote}"`;
  }
  draft.narration = narration;
}

function houseRoot(state: State, config: Config): string | null {
  let id = state.entities[config.player_id]?.location ?? null;
  const seen = new Set<string>();
  let root: string | null = null;
  while (id && !seen.has(id)) {
    seen.add(id);
    const entity = state.entities[id];
    if (!entity || entity.type !== "place") break;
    root = id;
    id = entity.location;
  }
  return root;
}

function insideHouse(state: State, house: string, placeId: string): boolean {
  let id: string | null = placeId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    if (id === house) return true;
    seen.add(id);
    const next: string | null = state.entities[id]?.location ?? null;
    id = next;
  }
  return false;
}

function mentionsPlace(text: string, place: Entity): boolean {
  const hay = norm(text);
  const names = [place.name, ...place.aliases, place.id.replace(/[_-]+/g, " ")];
  return names.some((name) => {
    const needle = norm(name).replace(/^(?:the|a|an)\s+/, "");
    return needle.length >= 3 && hay.includes(needle);
  });
}

function livesOffsite(entity: Entity, state: State, house: string | null): boolean {
  if (entity.type !== "person") return false;
  for (const fact of entity.facts) {
    if (!/\blives?\b/i.test(fact.text)) continue;
    if (house) {
      const home = state.entities[house];
      if (home && mentionsPlace(fact.text, home)) return false;
    }
    return true;
  }
  return false;
}

function namedIn(text: string, entity: Entity): boolean {
  for (const term of [entity.name, ...entity.aliases]) {
    if (term.trim().length < 3) continue;
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text)) return true;
  }
  return false;
}

function broughtAlong(input: string, narration: string, entity: Entity): boolean {
  const hay = `${input}\n${narration}`;
  if (!namedIn(hay, entity)) return false;
  return BROUGHT.test(hay);
}

/**
 * Someone whose home is not this house does not appear in it unless this turn brought them.
 * Housemates, whose facts name the house or name no other home, still move from room to room.
 */
export function holdGuests(state: State, config: Config, draft: TurnDraft, input: string): void {
  const house = houseRoot(state, config);
  if (!house) return;
  const offsite = (id: string, facts: string[]): boolean => {
    const existing = state.entities[id];
    if (existing && livesOffsite(existing, state, house)) return true;
    return facts.some((fact) => /\blives?\b/i.test(fact) && !mentionsPlace(fact, state.entities[house]!));
  };
  draft.delta = draft.delta.flatMap((op) => {
    const rec = asRec(op);
    if (!rec) return [op];
    if (rec.op === "entity.move" && typeof rec.id === "string" && typeof rec.location === "string") {
      const person = state.entities[rec.id];
      if (!person || person.type !== "person" || person.id === config.player_id) return [op];
      if (!insideHouse(state, house, rec.location)) return [op];
      if (!livesOffsite(person, state, house)) return [op];
      if (broughtAlong(input, draft.narration, person)) return [op];
      return [];
    }
    if (rec.op === "entity.create" && rec.type === "person" && typeof rec.location === "string" && typeof rec.id === "string") {
      const facts = Array.isArray(rec.facts) ? rec.facts.filter((fact): fact is string => typeof fact === "string") : [];
      if (!insideHouse(state, house, rec.location) || !offsite(rec.id, facts)) return [op];
      const shell: Entity = {
        id: rec.id,
        type: "person",
        name: typeof rec.name === "string" ? rec.name : rec.id,
        aliases: [],
        location: null,
        facts: [],
        tags: [],
        last_touched: 0,
      };
      if (broughtAlong(input, draft.narration, shell)) return [op];
      const next = { ...rec };
      delete next.location;
      return [next];
    }
    return [op];
  });
}

const SUBJECT_PRONOUN = /\b(he|she|they)\b/gi;

/**
 * The first subject pronoun used for one named person sticks for the day.
 * A sentence that names two people does not decide.
 */
export function notePronouns(state: State, narration: string): void {
  const people = Object.values(state.entities).filter((entity) => entity.type === "person");
  const sentences = narration.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const named = people.filter((person) => namedIn(sentence, person));
    if (named.length !== 1) continue;
    const person = named[0];
    if (!person || person.tags.some((tag) => tag.startsWith("pronoun:"))) continue;
    const hits = [...sentence.matchAll(SUBJECT_PRONOUN)].map((match) => match[1]?.toLowerCase() ?? "");
    if (hits.length === 0) continue;
    const kind = hits.every((hit) => hit === hits[0]) ? hits[0] : null;
    if (!kind) continue;
    person.tags.push(`pronoun:${kind}`);
  }
}
