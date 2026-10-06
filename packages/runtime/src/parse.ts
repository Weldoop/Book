import { TurnDraftSchema, type TurnDraft } from "@book/schema";
import { z } from "zod";

/** Pulls the first JSON object out of model text, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(candidate.slice(start, end + 1));
}

export type ParsedDraft = { ok: true; draft: TurnDraft } | { ok: false; error: string };

const HIDDEN = /\[\s*HIDDEN\s*:\s*([^\]]*)\]/gi;

/**
 * Safety net for the private-notes habit: some models write `[HIDDEN: ...]` inline because that is
 * how other story games ask for it. Lift any of it out of the narration into `notes`, so a private
 * thought can never reach the player through the transcript.
 */
export function liftHiddenNotes(draft: TurnDraft): TurnDraft {
  const lifted: string[] = [];
  const stripped = draft.narration.replace(HIDDEN, (_match, note: string) => {
    const text = note.trim();
    if (text) lifted.push(text);
    return "";
  });
  if (stripped === draft.narration) return draft;
  const narration = stripped.replace(/[ \t]{2,}/g, " ").trim();
  return { ...draft, narration, notes: [...(draft.notes ?? []), ...lifted] };
}

/** The first sentence of the narration, capped, so a missing beat does not cost a model call. */
function beatFromNarration(narration: string): string {
  const flat = narration.replace(/\s+/g, " ").trim();
  const sentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  return sentence.trim().split(/\s+/).filter(Boolean).slice(0, 20).join(" ");
}

/**
 * A reply that is already one JSON object keeps its delta.
 * A missing beat is filled from the narration. A focus sentence is dropped.
 * Neither is a repair.
 */
function prepareDraft(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const draft = { ...(value as Record<string, unknown>) };
  if (typeof draft.focus_next === "string") delete draft.focus_next;
  const beat = typeof draft.beat === "string" ? draft.beat.trim() : "";
  const narration = typeof draft.narration === "string" ? draft.narration.trim() : "";
  const deltaOk = draft.delta === undefined || Array.isArray(draft.delta);
  if (!beat && narration && deltaOk) {
    const filled = beatFromNarration(narration);
    if (filled) draft.beat = filled;
  }
  if (draft.scene_ended === true) {
    const title = typeof draft.chapter_title === "string" ? draft.chapter_title.trim() : "";
    const source = title || (typeof draft.beat === "string" ? draft.beat.trim() : "");
    const chapter = source.split(/\s+/).filter(Boolean).slice(0, 8).join(" ").replace(/[.!?]+$/, "");
    if (chapter) draft.chapter_title = chapter;
  }
  return draft;
}

export function parseDraftText(text: string): ParsedDraft {
  let value: unknown;
  try {
    value = extractJson(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid JSON" };
  }
  const parsed = TurnDraftSchema.safeParse(prepareDraft(value));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "draft"}: ${issue?.message ?? "invalid"}` };
  }
  const draft = liftHiddenNotes(parsed.data);
  if (draft.narration.length === 0) {
    return { ok: false, error: "narration: the reply was nothing but a hidden note" };
  }
  return { ok: true, draft };
}

const DeltaRepairSchema = z.object({
  delta: z.array(z.unknown()),
  beat: z.string().optional(),
  at: z.string().optional(),
});

export function parseDeltaRepair(
  text: string,
): { ok: true; delta: unknown[]; beat?: string; at?: string } | { ok: false; error: string } {
  try {
    const parsed = DeltaRepairSchema.safeParse(extractJson(text));
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
    return {
      ok: true,
      delta: parsed.data.delta,
      ...(parsed.data.beat ? { beat: parsed.data.beat } : {}),
      ...(parsed.data.at ? { at: parsed.data.at } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid JSON" };
  }
}
