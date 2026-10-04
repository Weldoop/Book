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

export function parseDraftText(text: string): ParsedDraft {
  let value: unknown;
  try {
    value = extractJson(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid JSON" };
  }
  const parsed = TurnDraftSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "draft"}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, draft: parsed.data };
}

const DeltaRepairSchema = z.object({
  delta: z.array(z.unknown()),
  beat: z.string().optional(),
});

export function parseDeltaRepair(text: string): { ok: true; delta: unknown[]; beat?: string } | { ok: false; error: string } {
  try {
    const parsed = DeltaRepairSchema.safeParse(extractJson(text));
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
    return { ok: true, delta: parsed.data.delta, ...(parsed.data.beat ? { beat: parsed.data.beat } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid JSON" };
  }
}
