import { addMinutes, applyDraft, validateDraft } from "@book/engine";
import { buildRepairContext, buildTurnContext } from "@book/context";
import { renderView } from "@book/modules";
import type { Attempt, Config, Module, State, TurnDraft, TurnRecord, Violation } from "@book/schema";
import { parseDraftText } from "./parse.ts";
import type { Runtime, TurnResult } from "./runtime.ts";

const OPENING_MAX_TOKENS = 1000;
const OPENING_INPUT = "The book opens.";

/**
 * A new save deals its own first chapter. Works on a copy: a failed write leaves the seed
 * untouched, and nothing here is written back into the config.
 */
export async function openBook(rt: Runtime, saveId: string): Promise<TurnResult | null> {
  if (!rt.config.opening) return null;
  const saved = await rt.store.loadSave(saveId);
  if (saved.turn !== 0) return null;

  const frame = stripCast(saved, rt.config);
  const instruction = openingInstruction(rt.config);
  const ctx = buildTurnContext({
    config: rt.config,
    state: frame,
    modules: rt.modules,
    input: instruction,
    kind: "act",
    due: [],
  });

  const usages = [];
  const attempts: Attempt[] = [];
  const first = await rt.llm.complete({
    tier: "strong",
    purpose: "opening",
    system: ctx.system,
    messages: ctx.messages,
    max_tokens: OPENING_MAX_TOKENS,
    json: true,
  });
  usages.push(first.usage);

  let current = evaluate(frame, rt, first.text);
  attempts.push({
    kind: "draft",
    draft: current.draft ?? current.text,
    ...(rt.logRaw ? { raw: first.text } : {}),
    violations: current.violations,
    usage: first.usage,
  });

  if (!accepted(current)) {
    const rc = buildRepairContext({
      kind: "rewrite_repair",
      config: rt.config,
      state: frame,
      modules: rt.modules,
      input: instruction,
      draftText: current.text,
      violations: current.violations.length > 0 ? current.violations : unmetViolation(current.draft),
      ...(current.draft ? { narration: current.draft.narration } : {}),
      due: [],
    });
    const res = await rt.llm.complete({
      tier: "strong",
      purpose: "rewrite_repair",
      system: rc.system,
      messages: rc.messages,
      max_tokens: OPENING_MAX_TOKENS,
      json: true,
    });
    usages.push(res.usage);
    current = evaluate(frame, rt, res.text);
    attempts.push({
      kind: "rewrite_repair",
      draft: current.draft ?? current.text,
      ...(rt.logRaw ? { raw: res.text } : {}),
      violations: current.violations,
      usage: res.usage,
    });
  }

  const draft = accepted(current) && current.draft ? current.draft : fallbackDraft(frame, rt.config, rt.modules);
  const next = applyDraft(frame, rt.config, rt.modules, draft, {
    input: OPENING_INPUT,
    due: [],
    shown_threads: ctx.threads_shown ?? [],
  });
  const outcome = attempts.length > 1 ? "repaired" : "ok";
  const record: TurnRecord = {
    turn: next.turn,
    kind: "act",
    input: OPENING_INPUT,
    narration: draft.narration,
    beat: draft.beat,
    delta: draft.delta,
    due: [],
    ...(ctx.threads_shown?.length ? { threads_shown: ctx.threads_shown } : {}),
    attempts,
    outcome,
    context_parts: ctx.parts,
    usage: usages,
    at: new Date().toISOString(),
  };
  await rt.store.commitTurn({ save_id: saveId, expected_turn: 0, state: next, record });

  const view = renderView(rt.config, next, rt.modules);
  return {
    turn: next.turn,
    kind: "act",
    narration: draft.narration,
    status: view.status,
    panel: view.panel,
    outcome,
    notices: [],
    ...(next.scene.closed ? { scene_ended: true } : {}),
    ...(draft.suggested_actions?.length ? { suggestions: draft.suggested_actions } : {}),
    ...(next.window.at(-1)?.highlights?.length ? { highlights: next.window.at(-1)?.highlights } : {}),
    record,
  };
}

function openingInstruction(config: Config): string {
  return [
    `The book opens. This is the first chapter of ${config.meta.title}, not the whole story.`,
    config.meta.premise ? `The book is this: ${config.meta.premise}` : "",
    "Deal 3 or 4 adults who are not already in this save. Invent them. Create each with entity.create before anything refers to them. Do not recreate a person who was removed.",
    pinnedLine(config),
    'Tag a person "unmet" when they are not in the player\'s current room. Do not name an unmet person in the narration, and do not treat them as present.',
    'If someone mentions a place the player has not entered, entity.create it in this same delta with the tag "unvisited".',
    'Open 1 or 2 threads with thread.open and set scale to "major". These are the long matters of the first chapter. Put the people and places each one turns on in entities. At least one is due in the future. Do not make the world\'s calendar the only goal.',
    "The narration is the player's first moment. Do not decide their feelings, words or actions, and do not list the cast.",
    "Other people know only what they have seen, heard, or been told.",
    `The player character id is "${config.player_id}".`,
  ].join(" ");
}

function pinnedLine(config: Config): string {
  const ids = config.opening?.pinned ?? [];
  const people = ids
    .map((id) => config.seed.entities.find((entity) => entity.id === id && entity.type === "person"))
    .filter((entity): entity is NonNullable<typeof entity> => entity !== undefined);
  if (people.length === 0) return "No character is pinned. Do not keep a seeded housemate by recreating their name.";
  return `These people are pinned by the book and stay: ${people.map((person) => `${person.name} (${person.id})`).join(", ")}. Do not create a second copy of them.`;
}

/** A scene the player can read when the model opening cannot be accepted. People come from the book's cast pool. */
function fallbackDraft(state: State, config: Config, modules: Module[]): TurnDraft {
  const placeId = state.entities[config.player_id]?.location ?? undefined;
  const place = placeId ? state.entities[placeId] : undefined;
  const dealt = dealCast(state.rng_seed, config.opening?.cast ?? []).filter((person) => !state.entities[person.id]);
  const present = placeId ? dealt[0] : undefined;
  const rest = present ? dealt.slice(1) : dealt;
  const where = place?.name ?? "the room";
  const narration = present
    ? `The morning is already moving in ${where}. ${present.name} is here, mid-thought, and the rest of the house is somewhere else.`
    : config.meta.premise.trim() || `The morning is already moving in ${where}. Nothing has been decided yet.`;
  const delta: TurnDraft["delta"] = [{ op: "clock.advance", minutes: 1 }];
  if (present) {
    delta.unshift({
      op: "entity.create",
      id: present.id,
      type: "person",
      name: present.name,
      location: placeId,
      facts: present.facts.length > 0 ? present.facts : ["Here as the day starts."],
    });
  }
  for (const person of rest) {
    delta.push({
      op: "entity.create",
      id: person.id,
      type: "person",
      name: person.name,
      tags: ["unmet"],
      facts: person.facts.length > 0 ? person.facts : ["Not in the room yet."],
    });
  }
  if (present) {
    const due = `${addMinutes(state.clock.now, 24 * 60).slice(0, 10)}T18:00`;
    delta.push({
      op: "thread.open",
      kind: "commitment",
      text: `${present.name} is waiting on an answer about money before tomorrow evening.`,
      due,
      entities: [present.id],
      scale: "major",
    });
  }
  const draft: TurnDraft = {
    narration,
    delta,
    beat: narration.split(/(?<=[.!?])\s/)[0]?.split(/\s+/).slice(0, 20).join(" ") ?? "The day starts.",
  };
  const checked = validateDraft(state, config, modules, draft, OPENING_INPUT);
  if (checked.violations.length > 0) {
    const quiet = config.meta.premise.trim() || `The morning is already moving in ${where}.`;
    return { narration: quiet, delta: [{ op: "clock.advance", minutes: 1 }], beat: "The day starts." };
  }
  return draft;
}

function dealCast(seed: number, cast: { id: string; name: string; facts: string[] }[]): { id: string; name: string; facts: string[] }[] {
  const ranked = cast.map((person, index) => ({ person, rank: (seed + index * 97) % 1009 }));
  ranked.sort((a, b) => a.rank - b.rank || a.person.id.localeCompare(b.person.id));
  return ranked.slice(0, 3).map((row) => row.person);
}

/** Drops the seeded cast and its threads. Pinned people, places, factions and the player's own things stay. */
function stripCast(state: State, config: Config): State {
  const next = structuredClone(state);
  const pinned = new Set(config.opening?.pinned ?? []);
  const removed = new Set<string>();
  for (const entity of Object.values(next.entities)) {
    if (entity.type === "person" && entity.id !== config.player_id && !pinned.has(entity.id)) {
      removed.add(entity.id);
      delete next.entities[entity.id];
    }
  }
  next.threads = [];
  next.focus_next = next.focus_next.filter((id) => next.entities[id]);

  const rel = next.modules.relationships as { values?: Record<string, number> } | undefined;
  if (rel?.values) {
    for (const key of Object.keys(rel.values)) {
      const [a, b] = key.split("|");
      if ((a && removed.has(a)) || (b && removed.has(b))) delete rel.values[key];
    }
  }
  const inv = next.modules.inventory as { owners?: Record<string, Record<string, number>> } | undefined;
  if (inv?.owners) {
    for (const owner of Object.keys(inv.owners)) {
      if (removed.has(owner)) delete inv.owners[owner];
    }
  }
  return next;
}

function evaluate(state: State, rt: Runtime, text: string): { draft: TurnDraft | null; text: string; violations: Violation[] } {
  const parsed = parseDraftText(text);
  if (!parsed.ok) {
    return {
      draft: null,
      text,
      violations: [
        {
          severity: "fixable",
          code: "unparseable",
          message: `The reply could not be read as the required JSON object (${parsed.error}). Reply with exactly one JSON object with keys narration, delta, beat.`,
        },
      ],
    };
  }
  const result = validateDraft(state, rt.config, rt.modules, parsed.draft);
  const named = unmetNamed(parsed.draft);
  if (named) {
    result.violations.push({
      severity: "fixable",
      code: "named_unmet",
      message: `The narration names ${named}, who is tagged unmet. Do not name them until they share the player's location.`,
    });
  }
  return { draft: parsed.draft, text, violations: result.violations };
}

function accepted(current: { draft: TurnDraft | null; violations: { length: number } }): boolean {
  return current.draft !== null && current.violations.length === 0;
}

function unmetViolation(draft: TurnDraft | null): Violation[] {
  const named = draft ? unmetNamed(draft) : null;
  if (!named) return [];
  return [
    {
      severity: "fixable",
      code: "named_unmet",
      message: `The narration names ${named}, who is tagged unmet. Do not name them until they share the player's location.`,
    },
  ];
}

function unmetNamed(draft: TurnDraft): string | null {
  for (const op of draft.delta) {
    if (!op || typeof op !== "object") continue;
    const rec = op as Record<string, unknown>;
    if (rec.op !== "entity.create" || rec.type !== "person") continue;
    const tags = Array.isArray(rec.tags) ? rec.tags.filter((t): t is string => typeof t === "string") : [];
    if (!tags.includes("unmet")) continue;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (name && word(name).test(draft.narration)) return name;
  }
  return null;
}

function word(term: string): RegExp {
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
}
