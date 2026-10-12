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

const CLAUSE_DENIAL =
  /\b(?:no one|nobody|no-one|never|didn't|did not|don't|do not|doesn't|does not|wasn't|was not|isn't|is not|aren't|are not|can't|cannot|won't|will not|haven't|have not|hasn't|has not)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole words, or a whole phrase. "rys" does not match inside "Cerys". */
function termPattern(keyword: string): RegExp | null {
  const parts = keyword
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const body = parts.map((part) => escapeRegExp(part)).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
}

/**
 * The keyword is refused when a denial governs it: a denial word before it in the same clause,
 * or a "not" / "didn't" straight after it. "milk, not the Co-op" still affirms milk.
 */
function occurrenceAffirmed(sentence: string, index: number, length: number): boolean {
  const before = sentence.slice(0, index);
  const after = sentence.slice(index + length);
  const left = before.split(/,|\bbut\b|\(/i).pop() ?? before;
  if (CLAUSE_DENIAL.test(left) || /\b(?:no|not)\b/i.test(left)) return false;
  const right = after.slice(0, 48);
  if (/^\s*(?:is|are|was|were|has|have|'s|s)?\s*(?:n't|not)\b/i.test(right)) return false;
  if (/^\s*(?:didn't|did not|doesn't|does not|won't|will not|isn't|is not|wasn't|was not)\b/i.test(right)) return false;
  return true;
}

/** "4 p.m." and "4pm" are the same clock as "4 pm". */
function normalizeClockWords(text: string): string {
  return text.replace(/\b(\d{1,2})\s*([ap])\.?\s*m\.?\b/gi, (_match, hour: string, ap: string) => `${hour} ${ap.toLowerCase()}m`);
}

/** A probe passes when some sentence affirms a keyword as a whole word. A denial of that word does not. */
export function scoreProbe(answer: string, expectAny: string[]): boolean {
  const normalizedAnswer = normalizeClockWords(answer);
  const parts = normalizedAnswer
    .split(/[.!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const sentences = parts.length > 0 ? parts : [normalizedAnswer];
  return expectAny.some((keyword) => {
    const pattern = termPattern(normalizeClockWords(keyword));
    if (!pattern) return false;
    return sentences.some((sentence) => {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(sentence); match !== null; match = pattern.exec(sentence)) {
        if (occurrenceAffirmed(sentence, match.index, match[0].length)) return true;
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
      return false;
    });
  });
}

/** Probes not yet asked whose `after_turn` has been reached. */
export function dueProbes(probes: Probe[], asked: Set<Probe>, currentTurn: number): Probe[] {
  return probes.filter((p) => !asked.has(p) && p.after_turn <= currentTurn);
}
