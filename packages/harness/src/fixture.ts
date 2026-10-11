import { z } from "zod";

export const FixtureSchema = z
  .object({
    id: z.string(),
    inputs: z.array(z.object({ turn: z.number().int(), text: z.string() })).min(1),
  })
  .passthrough();
export type Fixture = z.infer<typeof FixtureSchema>;

export const ProbeSchema = z.object({
  after_turn: z.number().int().min(0),
  question: z.string().min(1),
  expect_any: z.array(z.string().min(1)).min(1),
});
export type Probe = z.infer<typeof ProbeSchema>;

export function parseFixture(json: unknown, source = "fixture"): Fixture {
  const r = FixtureSchema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`${source} is not a valid fixture: ${i?.path.join(".") ?? ""} ${i?.message ?? ""}`);
  }
  return { ...r.data, inputs: [...r.data.inputs].sort((a, b) => a.turn - b.turn) };
}

export function parseProbes(json: unknown, source = "probes"): Probe[] {
  const r = z.array(ProbeSchema).safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`${source} is not a valid probes file: ${i?.path.join(".") ?? ""} ${i?.message ?? ""}`);
  }
  return [...r.data].sort((a, b) => a.after_turn - b.after_turn);
}

const DENIAL =
  /\b(?:no one|nobody|no-one|never|not|didn't|did not|don't|do not|doesn't|does not|wasn't|was not|isn't|is not|aren't|are not|can't|cannot|won't|will not|haven't|have not|hasn't|has not)\b/i;

/** A probe passes when the answer affirms a keyword. A denial that still contains the word does not. */
export function scoreProbe(answer: string, expectAny: string[]): boolean {
  const parts = answer
    .split(/[.!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const sentences = parts.length > 0 ? parts : [answer];
  return expectAny.some((keyword) => {
    const needle = keyword.toLowerCase();
    return sentences.some((sentence) => sentence.toLowerCase().includes(needle) && !DENIAL.test(sentence));
  });
}

/** Probes not yet asked whose `after_turn` has been reached. */
export function dueProbes(probes: Probe[], asked: Set<Probe>, currentTurn: number): Probe[] {
  return probes.filter((p) => !asked.has(p) && p.after_turn <= currentTurn);
}
