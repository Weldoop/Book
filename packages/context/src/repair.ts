import type { Config, DueItem, Module, State, Violation } from "@book/schema";
import { mapAttention } from "./attention.ts";
import { resolveBudget } from "./budget.ts";
import { describeOps } from "./ops.ts";
import { engineNowSection, focusSection, sceneSection, stateSection } from "./sections.ts";
import { worldSheetSection } from "./world.ts";
import { extractJsonObject, tokensOf } from "./text.ts";
import { assembleTurn, joinSections, sumTokens } from "./turn.ts";
import type { BuiltContext, ContextPart, OutputOrder } from "./types.ts";

export interface RepairInput {
  kind: "delta_repair" | "rewrite_repair";
  config: Config;
  state: State;
  modules: Module[];
  input: string;
  draftText: string;
  violations: Violation[];
  narration?: string;
  /** Needed by rewrite_repair so the rewrite sees the same turn as the rejected draft. */
  turn_kind?: "act" | "continue";
  due?: DueItem[];
  fate?: number;
  outputOrder?: OutputOrder;
}

export const REWRITE_RULE =
  "Your previous draft broke the rules; write a new one that respects them. Keep the player's intent and change only what is needed.";

const DELTA_BUDGET = { state_snapshot: 400, entities_in_focus: 450 } as const;
const REJECTED_DRAFT_CAP = 1000;
const NARRATION_CAP = 600;
const DELTA_FOCUS_LIMIT = 6;

function deltaRepairSystem(config: Config, modules: Module[]): string {
  const local = config.travel.local;
  const localNote = local.length > 0 ? ` A step to ${local.join(", ")} is not a new place.` : "";
  return [
    "You repair the bookkeeping of one story turn. Code owns the truth; you never write state, you propose `delta` ops.",
    "RULES",
    "- Every change to money, stats, items, time, relationships, threads or new named characters must appear in delta.",
    "- Elapsed time goes in delta as clock.advance (minutes).",
    "- Declare every new named person or place with entity.create before any op refers to it.",
    "- Use only ids shown in the context. Item ids must be copied from the world sheet. Move the player with entity.move to a place id.",
    "- A purchase of one catalog item is inventory.add of that item and one negative stat.add of its price. A second item needs its own pair.",
    "- A priced purchase is a whole multiple of the catalog price and inventory.add to the player. Never take less than one unit. Stat keys are the ids in STATE, not the labels.",
    "- ENGINE NOW is the save. Carrying there is already owned, including turns that have left the chat. Do not inventory.add or charge an item that line already lists. Do not change money, place, or what is carried to match an older figure in the narration.",
    `- If the player asked to go somewhere and was not refused, entity.move them to a place that matches. Create the place first when the world sheet has no such place.${localNote}`,
    "- If clock.advance is longer than one scene, replace it with clock.skip (a reason is required) and keep the move.",
    "- Never invent ops or fields.",
    "OPS",
    describeOps(modules),
    'Return ONLY a JSON object {"delta":[...],"beat":"...","at":"<place id, when the scene stops in a place>"} that corrects the rejected ops. Do not change the narration.',
  ].join("\n");
}

/** Shown again when a repair reply is not JSON. The engine still does not invent the ops. */
export function deltaFormatHint(playerId: string): string {
  return [
    "That reply was not valid JSON. Return one JSON object and nothing else.",
    `{"delta":[{"op":"entity.create","id":"<place-id>","type":"place","name":"<Place name>"},{"op":"entity.move","id":"${playerId}","location":"<place-id>"}],"at":"<place-id>","beat":"You arrive."}`,
    "Create the place only when the world sheet does not already have it, then move the player, and set at to that place id. Copy the ids from the violation. Leave out entity.create when the place already exists. Do not add a trip the player did not ask for.",
  ].join("\n");
}

export function violationLines(violations: Violation[]): string[] {
  return violations.map((v) => {
    const where = v.op_index !== undefined ? `, delta[${v.op_index}]` : "";
    return `- ${v.message} (${v.code}, ${v.severity}${where})`;
  });
}

function capText(text: string, capTokens: number): { text: string; trimmed: boolean } {
  const max = capTokens * 4;
  if (text.length <= max) return { text, trimmed: false };
  return { text: `${text.slice(0, max)} …`, trimmed: true };
}

interface DraftView {
  narration: string | undefined;
  rejected: string;
  ids: string[];
}

const ID_FIELDS = ["id", "owner", "a", "b", "location"];

function viewDraft(draftText: string, narration: string | undefined): DraftView {
  const parsed = extractJsonObject(draftText);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const delta = obj && Array.isArray(obj.delta) ? obj.delta : null;
  const ids: string[] = [];
  if (delta) {
    for (const op of delta) {
      if (!op || typeof op !== "object") continue;
      const rec = op as Record<string, unknown>;
      for (const f of ID_FIELDS) if (typeof rec[f] === "string") ids.push(rec[f] as string);
      if (Array.isArray(rec.entities)) for (const e of rec.entities) if (typeof e === "string") ids.push(e);
    }
  }
  const draftNarration = obj && typeof obj.narration === "string" ? obj.narration : undefined;
  const rejected = delta
    ? JSON.stringify({ delta, ...(obj && typeof obj.beat === "string" ? { beat: obj.beat } : {}) })
    : draftText;
  return { narration: narration ?? draftNarration, rejected, ids };
}

export function buildRepairContext(i: RepairInput): BuiltContext {
  return i.kind === "delta_repair" ? buildDeltaRepair(i) : buildRewriteRepair(i);
}

function buildDeltaRepair(i: RepairInput): BuiltContext {
  const budget = resolveBudget(DELTA_BUDGET);
  const view = viewDraft(i.draftText, i.narration);
  const narration = view.narration ? capText(view.narration, NARRATION_CAP) : null;
  const rejected = capText(view.rejected, REJECTED_DRAFT_CAP);

  const attended = mapAttention({
    config: i.config,
    state: i.state,
    modules: i.modules,
    input: `${i.input} ${narration?.text ?? ""}`,
    due: [],
    limit: DELTA_FOCUS_LIMIT,
  });
  const referenced = view.ids.filter((id) => i.state.entities[id] && id !== i.config.player_id);
  const ids = [...new Set([...referenced, ...attended])].slice(0, DELTA_FOCUS_LIMIT);
  const focus = focusSection(i.state, ids, budget.entities_in_focus);

  const sections = [
    { part: "scene", section: sceneSection(i.config, i.state) },
    { part: "world_sheet", section: worldSheetSection(i.config, i.state, budget.state_snapshot) },
    { part: "state_snapshot", section: stateSection(i.config, i.state, i.modules, budget.state_snapshot) },
    { part: "engine_now", section: engineNowSection(i.config, i.state, i.modules) },
    { part: "entities_in_focus", section: focus.section },
    {
      part: "narration",
      section: narration
        ? { text: `## NARRATION (do not change)\n${narration.text}`, trimmed: narration.trimmed }
        : { text: "", trimmed: false },
    },
    { part: "rejected_draft", section: { text: `## REJECTED OPS\n${rejected.text}`, trimmed: rejected.trimmed } },
    {
      part: "violations",
      section: { text: ["## VIOLATIONS", ...violationLines(i.violations)].join("\n"), trimmed: false },
    },
    { part: "input", section: { text: `## PLAYER INPUT\n${i.input}`, trimmed: false } },
  ];
  const system = deltaRepairSystem(i.config, i.modules);
  const parts: ContextPart[] = [
    { name: "contract", tokens: tokensOf(system), trimmed: false },
    ...sections.map(({ part, section }) => ({
      name: part,
      tokens: tokensOf(section.text),
      trimmed: section.trimmed,
    })),
  ];
  return {
    system: [{ text: system, cache: true }],
    messages: [{ role: "user", content: joinSections(sections) }],
    parts,
    total_tokens: sumTokens(parts),
    focus: focus.shown,
  };
}

function buildRewriteRepair(i: RepairInput): BuiltContext {
  const turn = assembleTurn({
    config: i.config,
    state: i.state,
    modules: i.modules,
    input: i.input,
    kind: i.turn_kind ?? (i.input.trim() === "..." || i.input.trim() === "" ? "continue" : "act"),
    due: i.due ?? [],
    ...(i.fate !== undefined ? { fate: i.fate } : {}),
    ...(i.outputOrder ? { outputOrder: i.outputOrder } : {}),
  });
  const draft = capText(i.draftText, REJECTED_DRAFT_CAP);
  const extra = [
    { part: "rejected_draft", section: { text: `## REJECTED DRAFT\n${draft.text}`, trimmed: draft.trimmed } },
    {
      part: "violations",
      section: { text: ["## RULE VIOLATIONS", ...violationLines(i.violations)].join("\n"), trimmed: false },
    },
    {
      part: "instructions",
      section: {
        text: "## INSTRUCTIONS\nRewrite this turn. Keep the player's intent, change only what is needed to respect the rules above, and output the full JSON object (narration, delta, beat). Do not mention the rejected draft or the rules in the narration.",
        trimmed: false,
      },
    },
  ];
  const sections = [...turn.sections, ...extra];
  const parts: ContextPart[] = [
    ...turn.parts,
    { name: "repair_rule", tokens: tokensOf(REWRITE_RULE), trimmed: false },
    ...extra.map(({ part, section }) => ({
      name: part,
      tokens: tokensOf(section.text),
      trimmed: section.trimmed,
    })),
  ];
  return {
    system: [...turn.system, { text: REWRITE_RULE }],
    messages: [{ role: "user", content: joinSections(sections) }],
    parts,
    total_tokens: sumTokens(parts),
    focus: turn.focus,
  };
}
