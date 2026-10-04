import { applyDraft, validateDraft } from "@book/engine";
import { buildRepairContext, buildTurnContext } from "@book/context";
import { renderView } from "@book/modules";
import type { Attempt, Config, State, TurnDraft, TurnRecord, Violation } from "@book/schema";
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

  if (!accepted(current) || !current.draft) return null;

  const draft = current.draft;
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
    record,
  };
}

function openingInstruction(config: Config): string {
  return [
    "The book opens. This is the first chapter of a longer life, not the whole story.",
    "Deal 3 or 4 adults who already belong to this world. Create each with entity.create before anything refers to them.",
    'Tag a person "unmet" when they are not in the player\'s current room. Do not name an unmet person in the narration, and do not treat them as present.',
    'If someone mentions a place the player has not entered, entity.create it in this same delta with the tag "unvisited".',
    "Open 1 to 3 threads with thread.open for this chapter. At least one is due in the future. The thread text may name the people you created. Do not make the world's calendar the only goal.",
    "The narration is the player's first moment. Do not decide their feelings, words or actions, and do not list the cast.",
    "Other people know only what they have seen, heard, or been told.",
    `The player character id is "${config.player_id}".`,
  ].join(" ");
}

/** Drops the seeded cast and its threads. Places, factions and the player's own things stay. */
function stripCast(state: State, config: Config): State {
  const next = structuredClone(state);
  const removed = new Set<string>();
  for (const entity of Object.values(next.entities)) {
    if (entity.type === "person" && entity.id !== config.player_id) {
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
