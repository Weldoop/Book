import { diffMinutes } from "./time.ts";

/** A resolved matter stays closed for this long, in story hours. */
export const RESOLVED_BLOCK_HOURS = 48;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** Words that carry no matter of their own. Overlap is counted on what is left. */
const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "your",
  "will",
  "before",
  "after",
  "into",
  "over",
  "about",
  "they",
  "them",
  "their",
  "been",
  "were",
  "when",
  "what",
  "where",
  "which",
  "would",
  "could",
  "should",
  "there",
  "here",
  "just",
  "only",
  "also",
  "than",
  "then",
  "some",
  "such",
  "must",
  "need",
  "needs",
  "until",
  "while",
  "because",
  "through",
  "during",
  "under",
  "again",
  "still",
  "back",
  "away",
  "down",
  "more",
  "most",
  "very",
  "like",
  "make",
  "made",
  "does",
  "being",
  "onto",
  "upon",
  "within",
  "without",
  "across",
  "around",
  "among",
  "between",
  "against",
  "every",
  "each",
  "other",
  "another",
  "these",
  "those",
  "someone",
  "something",
  "anything",
  "nothing",
  "everyone",
  "everything",
  "said",
  "says",
  "want",
  "wants",
  "going",
  "come",
  "came",
  "take",
  "took",
  "tell",
  "told",
  "know",
  "knew",
  "think",
  "thought",
  "really",
  "already",
  "please",
  "thanks",
  "towards",
  "toward",
  "shall",
  "might",
  "ought",
]);

export interface ThreadOverlap {
  id: string;
  status: string;
  text: string;
  due?: string | undefined;
  resolved_at?: string | undefined;
}

/** Calendar weekday of a local date, Sunday = 0. The clock has no timezone, so this uses the date alone. */
export function weekdayIndex(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return -1;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function namedWeekdays(text: string): number[] {
  const hay = text.toLowerCase();
  const found: number[] = [];
  WEEKDAYS.forEach((name, index) => {
    if (new RegExp(`\\b${name}s?\\b`).test(hay)) found.push(index);
  });
  return found;
}

/** The next date on or after `now` that falls on `weekday` (Sunday = 0). The clock has no timezone. */
function nextDateOn(now: string, weekday: number): string {
  const [year, month, day] = now.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return "";
  const current = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const add = (weekday - current + 7) % 7;
  const next = new Date(Date.UTC(year, month - 1, day + add));
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, "0");
  const d = String(next.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
}

/**
 * A thread that names a weekday has to fall on that weekday.
 * Monday in the text cannot be stored as the following Wednesday.
 * The message names the next date, so a repair can change the due date.
 */
export function weekdayMismatch(text: string, due: string | undefined, now?: string): string | null {
  const named = namedWeekdays(text);
  if (named.length === 0) return null;
  const title = (name: string) => name.slice(0, 1).toUpperCase() + name.slice(1);
  const label = named.map((index) => title(WEEKDAYS[index] ?? "")).join(" and ");
  const dates = named.map((index) => {
    const name = title(WEEKDAYS[index] ?? "");
    const date = now ? nextDateOn(now, index) : "";
    return date ? `${name} ${date}` : name;
  });
  const when = dateList(dates);
  if (!due) return `the thread names ${label} but has no due date. Set due to ${when}.`;
  const actual = weekdayIndex(due);
  if (actual < 0 || named.includes(actual)) return null;
  const day = WEEKDAYS[actual] ?? "unknown";
  return `the thread names ${label} but ${due.slice(0, 10)} is a ${title(day)}. Set due to ${when}.`;
}

/**
 * The due date a thread that names one weekday should carry: the next date on that weekday, at the
 * time of day the GM wrote. Nothing when the text names no weekday, two weekdays, or already fits.
 */
export function weekdayDue(text: string, due: string | undefined, now: string): string | undefined {
  if (!due) return undefined;
  const named = namedWeekdays(text);
  const weekday = named[0];
  if (named.length !== 1 || weekday === undefined) return undefined;
  const actual = weekdayIndex(due);
  if (actual < 0 || actual === weekday) return undefined;
  const date = nextDateOn(now, weekday);
  return date ? `${date}${due.slice(10)}` : undefined;
}

/** "Sat 3 Oct is 2026-10-03, Sun 4 Oct is 2026-10-04, ..." for the week ahead, so a named day lands on its date. */
export function weekAheadLine(now: string): string {
  const [year, month, day] = now.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return "";
  const parts: string[] = [];
  for (let add = 0; add < 7; add++) {
    const d = new Date(Date.UTC(year, month - 1, day + add));
    const name = WEEKDAYS[d.getUTCDay()] ?? "";
    const label = add === 0 ? "today" : add === 1 ? "tomorrow" : name.slice(0, 1).toUpperCase() + name.slice(1);
    parts.push(`${label} ${d.toISOString().slice(0, 10)}`);
  }
  return `Dates: ${parts.join(", ")}.`;
}

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    let word = raw;
    if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    if (word.length < 4 || STOP.has(word) || STOP.has(raw)) continue;
    out.add(word);
  }
  return out;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const word of a) if (b.has(word)) n += 1;
  return n;
}

/** Content words two texts have in common, after stop words and plurals. */
export function sharedContentWords(a: string, b: string): number {
  return sharedCount(contentWords(a), contentWords(b));
}

function recentlyResolved(thread: ThreadOverlap, now: string | undefined): boolean {
  if (thread.status !== "resolved" || !now || !thread.resolved_at) return false;
  const age = diffMinutes(now, thread.resolved_at);
  return age >= 0 && age < RESOLVED_BLOCK_HOURS * 60;
}

/**
 * An open thread this text would repeat. Four shared content words is enough on its own.
 * The same deadline needs two, so two events can share a minute without colliding.
 * A matter resolved inside the last 48 story hours counts as well, when `now` is passed.
 */
export function duplicateOpenThread(
  threads: readonly ThreadOverlap[],
  text: string,
  due?: string,
  now?: string,
): ThreadOverlap | undefined {
  const words = contentWords(text);
  for (const thread of threads) {
    if (thread.status !== "open" && !recentlyResolved(thread, now)) continue;
    const shared = sharedCount(words, contentWords(thread.text));
    if (shared >= 4) return thread;
    if (due !== undefined && thread.due === due && shared >= 2) return thread;
  }
  return undefined;
}
