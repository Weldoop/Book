import type { State, Thread, TurnDraft } from "@book/schema";
import { sharedContentWords } from "./threads.ts";
import { addMinutes, diffMinutes, parseLocal } from "./time.ts";

/**
 * "The shift is still five hours away" at 07:15 for a 17:00 shift, "the agent's coming in a few
 * hours" the day before the inspection: the clock is code's, so a distance to a deadline the
 * narration gets wrong is corrected against the thread's due date. Only a sentence that shares
 * two content words with exactly one open thread that has a due date is touched, and never
 * inside quotation marks. This is the one place the engine edits prose.
 */

const SMALL: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const QTY = String.raw`(?:${Object.keys(SMALL).join("|")}|\d{1,2})`;
const UNIT = String.raw`(minutes?|hours?|days?)`;
/** A count of time that is not a duration spent: "for three hours", "two hours ago", "an hour's walk" are left alone. */
const COUNT = new RegExp(
  String.raw`(?<!\b(?:for|every|spent|spend|took|takes|take|last|another|after|about an?)\s)\b(${QTY})\s+${UNIT}\b(?!\s*(?:ago|earlier|late|later|of|'s|long|straight|solid|each|or so\s+ago))`,
  "gi",
);
/** The sentence measures time to something: "away", "left", "until", "gives you", "to do something". */
const DISTANCE_CUE = /\b(?:away|off|left|to go|from now|until|till|before|gives? (?:you|us|me)|you(?:'ve)? (?:got|have)|we(?:'ve)? (?:got|have)|leaves (?:you|us)|to (?:do|get|sort|clear|shift|fix|make|find|save|spare|kill))\b/i;
/** "in a few hours", "in an hour", "in half an hour", "in a couple of hours", "in ten minutes" (as a forecast, not a plan). */
const IN_SOME = new RegExp(
  String.raw`\bin\s+(?:(a few|a couple of|several|half an|${QTY})\s+${UNIT}|(an hour or two|a day or two))\b(?!\s+(?:ago|earlier))`,
  "gi",
);
/** "later today", "this afternoon", "tonight", "tomorrow morning", "tomorrow". */
const DAY_WORD = /\b(later today|later on today|this morning|this afternoon|this evening|tonight|today|tomorrow(?: morning| afternoon| evening| night)?)\b/gi;

/** Minutes a vague phrase could reasonably mean. */
const VAGUE: Record<string, [number, number]> = {
  "a few": [90, 330],
  "a couple of": [75, 200],
  several: [150, 540],
  "half an": [20, 45],
  "an hour or two": [45, 150],
  "a day or two": [18 * 60, 60 * 60],
};

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

/** The clock this draft lands on, read from its clock ops, so "away" is measured from the end of the turn. */
export function clockAfter(state: State, draft: TurnDraft): string {
  let now = state.clock.now;
  for (const op of draft.delta) {
    const rec = op as { op?: unknown; minutes?: unknown; now?: unknown };
    if ((rec.op === "clock.advance" || rec.op === "clock.skip") && typeof rec.minutes === "number") now = addMinutes(now, rec.minutes);
    if (rec.op === "clock.set" && typeof rec.now === "string") {
      try {
        parseLocal(rec.now);
        now = rec.now;
      } catch {
        /* a bad clock.set is the validator's to report */
      }
    }
  }
  return now;
}

function insideQuotes(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const singles = (before.match(/(?<![a-z])'|'(?![a-z])/gi) ?? []).length;
  const doubles = (before.match(/["\u201c\u201d]/g) ?? []).length;
  return singles % 2 === 1 || doubles % 2 === 1;
}

function sentenceBounds(text: string, index: number): [number, number] {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n")) + 1;
  const rest = text.slice(index).search(/[.!?\n]/);
  return [start, rest < 0 ? text.length : index + rest];
}

/** The one open dated thread this stretch of text is about, or nothing. */
function threadFor(sentence: string, threads: readonly Thread[]): Thread | undefined {
  const hits = threads.filter((t) => t.status === "open" && t.due && sharedContentWords(sentence, t.text) >= 2);
  return hits.length === 1 ? hits[0] : undefined;
}

function toMinutes(qty: string, unit: string): number {
  const n = SMALL[qty.toLowerCase()] ?? Number(qty);
  const u = unit.toLowerCase();
  return u.startsWith("minute") ? n : u.startsWith("hour") ? n * 60 : n * 24 * 60;
}

/** Within three quarters of an hour, or a fifth of the stated span, is the model rounding, not wrong. */
function nearEnough(actual: number, stated: number): boolean {
  return Math.abs(actual - stated) <= Math.max(45, stated * 0.2);
}

function count(n: number): string {
  return n <= 12 ? (WORDS[n] ?? String(n)) : String(n);
}

/** "about ten hours", "about 40 minutes", "about two days", in the unit the distance deserves. */
function spanWords(minutes: number): string {
  if (minutes < 100) {
    const m = Math.max(5, Math.round(minutes / 5) * 5);
    return `about ${count(m)} minute${m === 1 ? "" : "s"}`;
  }
  if (minutes < 36 * 60) {
    const h = Math.round(minutes / 60);
    return `about ${count(h)} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(minutes / (24 * 60));
  return `about ${count(d)} day${d === 1 ? "" : "s"}`;
}

/** "tomorrow", "on Monday", "in about ten hours": the phrase that is true from `now`. */
function whenWords(now: string, due: string, minutes: number): string {
  const today = dateOf(now);
  const dueDay = dateOf(due);
  if (dueDay === today) return `in ${spanWords(minutes)}`;
  if (dueDay === dateOf(addMinutes(`${today}T00:00`, 24 * 60))) return "tomorrow";
  if (minutes < 6 * 24 * 60) return `on ${DAYS[new Date(parseLocal(due)).getUTCDay()]}`;
  return `in ${spanWords(minutes)}`;
}

function dayWordFits(word: string, now: string, due: string): boolean {
  const w = word.toLowerCase();
  const today = dateOf(now);
  const dueDay = dateOf(due);
  if (w.startsWith("tomorrow")) return dueDay === dateOf(addMinutes(`${today}T00:00`, 24 * 60));
  return dueDay === today;
}

interface Patch {
  start: number;
  end: number;
  text: string;
}

/** Corrects relative times in the narration against the dated threads. Returns what it changed. */
export function correctRelativeTimes(state: State, draft: TurnDraft): string[] {
  const narration = draft.narration;
  const now = clockAfter(state, draft);
  const patches: Patch[] = [];
  const consider = (index: number, length: number, replace: (thread: Thread, minutes: number) => string | null) => {
    if (insideQuotes(narration, index)) return;
    const [s, e] = sentenceBounds(narration, index);
    // "The inspection's Monday at ten. That gives you 38 hours": the matter is often in the sentence before.
    const [ps] = s > 0 ? sentenceBounds(narration, s - 1) : [s];
    const thread = threadFor(narration.slice(ps, e), state.threads);
    if (!thread?.due) return;
    const minutes = diffMinutes(thread.due, now);
    if (minutes <= 0) return;
    const text = replace(thread, minutes);
    if (text !== null) patches.push({ start: index, end: index + length, text });
  };

  for (const m of narration.matchAll(COUNT)) {
    if (m.index === undefined) continue;
    const qty = m[1] ?? "";
    const unit = m[2] ?? "";
    const [s, e] = sentenceBounds(narration, m.index);
    if (!DISTANCE_CUE.test(narration.slice(s, e))) continue;
    // "roughly 38 hours" is replaced whole, so the result is not "roughly about two days".
    const hedge = /\b(?:roughly|about|around|nearly|almost|some|just under|just over)\s+$/i.exec(narration.slice(0, m.index));
    const start = hedge ? m.index - hedge[0].length : m.index;
    consider(start, m.index + m[0].length - start, (_thread, minutes) => {
      const stated = toMinutes(qty, unit);
      if (nearEnough(minutes, stated)) return null;
      return spanWords(minutes);
    });
  }
  for (const m of narration.matchAll(IN_SOME)) {
    if (m.index === undefined) continue;
    const vague = (m[1] ?? m[3] ?? "").toLowerCase();
    const unit = m[2] ?? "";
    consider(m.index, m[0].length, (thread, minutes) => {
      const range = VAGUE[vague];
      if (range) {
        if (minutes >= range[0] && minutes <= range[1]) return null;
      } else {
        if (nearEnough(minutes, toMinutes(vague, unit))) return null;
      }
      return whenWords(now, thread.due ?? now, minutes);
    });
  }
  for (const m of narration.matchAll(DAY_WORD)) {
    if (m.index === undefined) continue;
    const word = m[1] ?? "";
    consider(m.index, m[0].length, (thread, minutes) => (dayWordFits(word, now, thread.due ?? now) ? null : whenWords(now, thread.due ?? now, minutes)));
  }

  if (patches.length === 0) return [];
  patches.sort((a, b) => b.start - a.start);
  let out = narration;
  const notes: string[] = [];
  let lastStart = Number.POSITIVE_INFINITY;
  for (const p of patches) {
    if (p.end > lastStart) continue;
    notes.unshift(`"${narration.slice(p.start, p.end).trim()}" -> "${p.text.trim()}"`);
    out = out.slice(0, p.start) + p.text + out.slice(p.end);
    lastStart = p.start;
  }
  draft.narration = out;
  return notes;
}
