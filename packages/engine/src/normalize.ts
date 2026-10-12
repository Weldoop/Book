import type { Config, Entity, State, TurnDraft } from "@book/schema";
import { catalogItems } from "./catalog.ts";
import { fillOrderedAt } from "./consistency.ts";
import { playerLocation } from "./core.ts";
import { duplicateOpenThread, weekdayDue } from "./threads.ts";
import { correctRelativeTimes } from "./reltime.ts";

type Rec = Record<string, unknown>;

const THREAD_KINDS = new Set(["commitment", "goal", "debt", "mystery", "callback"]);
const THREAD_SCALES = new Set(["potential", "minor", "major"]);

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asRec(op: unknown): Rec | null {
  return op && typeof op === "object" && !Array.isArray(op) ? (op as Rec) : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The entity an unknown id was written for. "tomos-reed" is the person named Tomos Reed, and
 * "tomos" is that person when no one else is called Tomos. An id that is also a real entity is left alone.
 */
export function resolveEntityId(state: State, id: string): string | null {
  if (state.entities[id]) return id;
  const needle = norm(id.replace(/[_.-]+/g, " "));
  if (needle.length < 3) return null;
  const entities = Object.values(state.entities);
  const exact = entities.filter((entity) => norm(entity.name) === needle || entity.aliases.some((alias) => norm(alias) === needle));
  if (exact.length === 1) return exact[0]?.id ?? null;
  if (exact.length > 1) return null;
  const partial = entities.filter((entity) => entity.type === "person" && norm(entity.name).split(" ").includes(needle));
  return partial.length === 1 ? (partial[0]?.id ?? null) : null;
}

function mapId(state: State, created: Set<string>, value: unknown, remap: Map<string, string>): unknown {
  if (typeof value !== "string" || state.entities[value] || created.has(value)) return value;
  const hit = remap.get(value) ?? resolveEntityId(state, value);
  if (!hit) return value;
  remap.set(value, hit);
  return hit;
}

/**
 * entity.create of someone already in the save becomes facts on that person. The rest of the delta follows the id.
 * New people are created before anything refers to them, whatever order the GM wrote the ops in.
 */
function remapEntities(state: State, draft: TurnDraft): void {
  const remap = new Map<string, string>();
  const created = new Set<string>();
  for (const op of draft.delta) {
    const rec = asRec(op);
    if (!rec || rec.op !== "entity.create" || typeof rec.id !== "string" || state.entities[rec.id]) continue;
    const hit = resolveEntityId(state, rec.id);
    const existing = hit ? state.entities[hit] : undefined;
    if (hit && existing && (rec.type === undefined || rec.type === existing.type)) remap.set(rec.id, hit);
    else created.add(rec.id);
  }
  const head: unknown[] = [];
  const rest: unknown[] = [];
  for (const op of draft.delta) {
    const rec = asRec(op);
    if (!rec) {
      rest.push(op);
      continue;
    }
    if (rec.op === "entity.create" && typeof rec.id === "string") {
      const hit = remap.get(rec.id);
      const existing = hit ? state.entities[hit] : undefined;
      if (hit && existing) {
        for (const fact of Array.isArray(rec.facts) ? rec.facts : []) {
          if (typeof fact === "string" && fact.trim() && !existing.facts.some((f) => f.text === fact)) {
            rest.push({ op: "entity.fact.add", id: hit, fact, importance: 2 });
          }
        }
        if (typeof rec.location === "string" && existing.type === "person") {
          rest.push({ op: "entity.move", id: hit, location: rec.location });
        }
        continue;
      }
      (created.has(rec.id) ? head : rest).push(op);
      continue;
    }
    for (const field of ["id", "owner", "a", "b", "location"]) {
      if (field in rec) rec[field] = mapId(state, created, rec[field], remap);
    }
    if (Array.isArray(rec.entities)) rec.entities = rec.entities.map((value) => mapId(state, created, value, remap));
    rest.push(op);
  }
  draft.delta = [...head, ...rest];
  if (draft.at && !state.entities[draft.at] && !created.has(draft.at)) {
    const hit = resolveEntityId(state, draft.at);
    if (hit && state.entities[hit]?.type === "place") draft.at = hit;
  }
  if (draft.focus_next) {
    draft.focus_next = draft.focus_next.map((id) => {
      const mapped = mapId(state, created, id, remap);
      return typeof mapped === "string" ? mapped : id;
    });
  }
}

/** A kind the schema does not know becomes a goal. "potential" was the scale, so it goes there. */
function lenientThreads(state: State, draft: TurnDraft): void {
  const out: unknown[] = [];
  for (const op of draft.delta) {
    const rec = asRec(op);
    if (!rec) {
      out.push(op);
      continue;
    }
    if (rec.op === "thread.open") {
      if (typeof rec.kind === "string" && !THREAD_KINDS.has(rec.kind)) {
        if (rec.kind === "potential" || rec.kind === "offer") rec.scale ??= "potential";
        rec.kind = "goal";
      }
      if (rec.scale !== undefined && (typeof rec.scale !== "string" || !THREAD_SCALES.has(rec.scale))) delete rec.scale;
      if (typeof rec.text === "string") {
        if (typeof rec.due === "string") rec.due = weekdayDue(rec.text, rec.due, state.clock.now) ?? rec.due;
        const due = typeof rec.due === "string" ? rec.due : undefined;
        const dup = duplicateOpenThread(state.threads, rec.text, due, state.clock.now);
        if (dup) {
          const existing = state.threads.find((thread) => thread.id === dup.id);
          if (existing?.status === "open" && (existing.scale === "minor" || existing.scale === "major")) {
            out.push({ op: "thread.adopt", id: existing.id, scale: existing.scale });
          }
          continue;
        }
      }
      out.push(op);
      continue;
    }
    if ((rec.op === "thread.adopt" || rec.op === "thread.resolve") && typeof rec.id === "string") {
      if (!state.threads.some((thread) => thread.id === rec.id)) continue;
    }
    out.push(op);
  }
  draft.delta = out;
}

/**
 * A good the sheet does not list is not tracked: the charge stays and the bag op goes.
 * Eating or handing over a good the bag never held is also just narration.
 */
function softenItems(state: State, config: Config, draft: TurnDraft): void {
  const catalog = catalogItems(config, state);
  if (catalog.length === 0 && config.items.length === 0) return;
  const createdHere = new Set<string>();
  for (const op of draft.delta) {
    const rec = asRec(op);
    if (rec?.op === "item.create" && typeof rec.id === "string") createdHere.add(rec.id);
  }
  const inventory = state.modules.inventory as { owners?: Record<string, Record<string, number>> } | undefined;
  const currency = new Set(config.stats.filter((stat) => stat.type === "currency").map((stat) => stat.key));
  const paid = draft.delta.some((op) => {
    const rec = asRec(op);
    return rec?.op === "stat.add" && typeof rec.key === "string" && currency.has(rec.key) && typeof rec.amount === "number" && rec.amount < 0;
  });
  draft.delta = draft.delta.filter((op) => {
    const rec = asRec(op);
    if (!rec || (rec.op !== "inventory.add" && rec.op !== "inventory.remove") || typeof rec.item !== "string") return true;
    const item = catalog.find((candidate) => candidate.id === rec.item);
    // A bought good the sheet does not list is not tracked: the charge stands and the bag op goes.
    if (!item) return createdHere.has(rec.item) || !paid;
    if (rec.op === "inventory.remove" && !item.keeps && typeof rec.owner === "string") {
      const qty = typeof rec.qty === "number" ? rec.qty : 1;
      const have = inventory?.owners?.[rec.owner]?.[rec.item] ?? 0;
      if (have < qty) return false;
    }
    return true;
  });
}

const LOCATIVE = String.raw`\b(?:in|into|inside|at|to|through to|down to|up to|back to|out to|over to|across to|round to)\s+(?:the\s+|your\s+|my\s+|his\s+|her\s+|their\s+|our\s+)?`;

/** "You head inside", "you go downstairs", "you slip back home": a bare alias after a verb of going. */
const GOING = String.raw`\b(?:head|heads|go|goes|get|gets|step|steps|slip|slips|walk|walks|come|comes|climb|climbs|wander|wanders|hurry|hurries|run|runs|drift|drifts|retreat|retreats|duck|ducks|make your way|trudge|trudges|pad|pads)\s+(?:back\s+|straight\s+|on\s+)?`;

/** A sentence about a plan, a listing, a message, or an earlier day is not where the player stands. */
const ELSEWHERE =
  /\b(?:tomorrow|tonight|later|next|last|yesterday|earlier|ago|went|were|was|had|did|shift|job|listed|advert|text|message|about|remember|used to|mention|plan|booked|interview|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/**
 * The sentence has the player in it ("you head", "you find Owen in the kitchen") and is not
 * about another time or a listing. "A shift listed at the corner shop" names a place without
 * anyone going there.
 */
function placeNamed(narration: string, place: Entity): boolean {
  const names = [place.name, ...place.aliases, place.id.replace(/[_-]+/g, " ")]
    .map((name) => name.replace(/^(?:the|your|my)\s+/i, "").trim())
    .filter((name) => name.length >= 3);
  const sentences = narration.split(/(?<=[.!?])\s+|\n+/);
  return sentences.some((sentence) => {
    if (!/\byou\b/i.test(sentence) || ELSEWHERE.test(sentence)) return false;
    return names.some((name) => {
      const word = escapeRegExp(name).replace(/\s+/g, "\\s+");
      return new RegExp(`(?:${LOCATIVE}|${GOING})${word}\\b`, "i").test(sentence);
    });
  });
}

function ancestors(state: State, id: string | null): Set<string> {
  const out = new Set<string>();
  let current = id ? state.entities[id] : undefined;
  while (current?.location && !out.has(current.location)) {
    out.add(current.location);
    current = state.entities[current.location];
  }
  return out;
}

/**
 * When the GM leaves `at` out, one place named after "in", "to", or "at" is where the player is.
 * Two candidate places mean the sentence is about somewhere else as well, so nothing is inferred.
 */
export function inferAt(state: State, config: Config, draft: TurnDraft): void {
  if (draft.at) return;
  const player = config.player_id;
  if (draft.delta.some((op) => asRec(op)?.op === "entity.move" && asRec(op)?.id === player)) return;
  const here = playerLocation(state, config);
  const above = ancestors(state, here);
  const named = Object.values(state.entities).filter(
    (entity) => entity.type === "place" && entity.id !== here && !above.has(entity.id) && placeNamed(draft.narration, entity),
  );
  const containers = new Set(named.map((place) => place.location).filter((id): id is string => typeof id === "string"));
  const leaves = named.filter((place) => !containers.has(place.id));
  if (leaves.length === 1 && leaves[0]) draft.at = leaves[0].id;
}

/**
 * A clock.advance longer than one scene, but inside the skip cap, is the skip the contract asked for.
 * Sleep and a voyage were failing because the draft used the short op for a long gap.
 */
function promoteLongAdvance(config: Config, draft: TurnDraft): void {
  const scene = config.time.max_per_turn;
  const skip = config.time.max_skip_minutes;
  if (skip <= 0) return;
  for (const op of draft.delta) {
    const rec = asRec(op);
    if (!rec || rec.op !== "clock.advance" || typeof rec.minutes !== "number") continue;
    if (rec.minutes <= scene || rec.minutes > skip) continue;
    rec.op = "clock.skip";
    if (typeof rec.reason !== "string" || rec.reason.trim().length === 0) rec.reason = "elapsed";
  }
}

/**
 * Deterministic tidying of a draft before validation. Nothing here reads a verb to invent a change:
 * it maps a name the model wrote for someone already in the save, fills a schema default,
 * drops an op about a good the save never tracked, and reads the place the sentence sits in.
 * The one edit to prose is a distance to a dated thread ("five hours away") corrected by the clock.
 * The player's named sheet place is filled before a place read out of the narration.
 */
export function normalizeDraft(state: State, config: Config, draft: TurnDraft, input = ""): void {
  remapEntities(state, draft);
  lenientThreads(state, draft);
  softenItems(state, config, draft);
  fillOrderedAt(state, config, draft, input);
  inferAt(state, config, draft);
  promoteLongAdvance(config, draft);
  correctRelativeTimes(state, draft);
}
