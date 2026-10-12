/** Lifetime spend for one signed-in person, across every save. */
export const PERSON_CAP_USD = 5;

/** The opening turn's input. It is not a line the player typed, so it cannot be edited. */
export const OPENING_INPUT = "The book opens.";

export const MAX_INPUT_CHARS = 2000;

export interface ShownLine {
  kind: "story" | "status" | "note";
  text: string;
}

export interface TranscriptItem {
  kind: "player" | "story" | "status" | "note";
  text: string;
}

export interface DebugPart {
  name: string;
  tokens: number;
  trimmed: boolean;
}

export interface DebugRepair {
  kind: string;
  violations: { severity: string; code: string; message: string }[];
}

export interface DebugView {
  spentUsd: number;
  capUsd: number;
  turn: number | null;
  outcome: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  parts: DebugPart[];
  repairs: DebugRepair[];
}

export interface SaveSummary {
  id: string;
  configId: string;
  title: string;
  turn: number;
  ended: boolean;
  updatedAt: string;
}

export interface GameCard {
  id: string;
  title: string;
  premise: string;
}

export interface PlayView {
  id: string;
  configId: string;
  title: string;
  turn: number;
  ended: boolean;
  suggestions: string[];
  lines: TranscriptItem[];
  /** Oldest turn in `lines`, when turns older than this page still exist. */
  before: string | null;
  lastInput: string | null;
  debug: DebugView;
  spentUsd: number;
  capUsd: number;
}

export interface LibraryView {
  games: GameCard[];
  saves: SaveSummary[];
  spentUsd: number;
  capUsd: number;
}

/** Lines brought back when the reader scrolls above the page already shown. */
export interface HistoryPage {
  lines: TranscriptItem[];
  before: string | null;
}

/** How many transcript lines a freshly opened save, or one scroll back, shows. */
export const PAGE_MESSAGES = 10;

export function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** A reason to refuse the next model call. The save is left as it is. */
export function capMessage(spentUsd: number, capUsd = PERSON_CAP_USD): string | null {
  if (spentUsd >= capUsd) {
    return `This account has used its $${capUsd.toFixed(0)} ($${spentUsd.toFixed(2)} spent). Your saves are intact.`;
  }
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email and password for the Supabase email provider. Passwords follow its default minimum of 6. */
export function cleanAccount(
  email: unknown,
  password: unknown,
): { ok: true; email: string; password: string } | { ok: false; error: string } {
  if (typeof email !== "string" || typeof password !== "string") {
    return { ok: false, error: "Enter an email and a password." };
  }
  const cleaned = email.trim().toLowerCase();
  if (!EMAIL.test(cleaned)) return { ok: false, error: "Enter the email address for this account." };
  if (password.length < 6) return { ok: false, error: "Use at least 6 characters for the password." };
  return { ok: true, email: cleaned, password };
}

export function cleanInput(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Type a line first." };
  const text = raw.trim();
  if (text.length > MAX_INPUT_CHARS) return { ok: false, error: "That line is too long. Try a shorter one." };
  return { ok: true, text: text.length === 0 ? "..." : text };
}

export interface DebugSource {
  turn: number;
  outcome: string;
  usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number; cost_usd: number }[];
  context_parts: { name: string; tokens: number; trimmed: boolean }[];
  attempts: {
    kind: string;
    violations: { severity: string; code: string; message: string }[];
    draft?: unknown;
    raw?: string;
  }[];
}

/** Context size, repairs, and cost. Draft text is omitted, so a private note in a draft cannot leak. */
export function debugFromRecord(spentUsd: number, record: DebugSource | null, capUsd = PERSON_CAP_USD): DebugView {
  if (!record) {
    return {
      spentUsd,
      capUsd,
      turn: null,
      outcome: null,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      parts: [],
      repairs: [],
    };
  }
  const sum = (pick: (row: DebugSource["usage"][number]) => number): number =>
    record.usage.reduce((n, row) => n + pick(row), 0);
  const repairs: DebugRepair[] = [];
  for (const attempt of record.attempts) {
    if (attempt.kind === "draft" && attempt.violations.length === 0) continue;
    repairs.push({
      kind: attempt.kind,
      violations: attempt.violations.map((v) => ({
        severity: v.severity,
        code: v.code,
        message: v.message,
      })),
    });
  }
  return {
    spentUsd,
    capUsd,
    turn: record.turn,
    outcome: record.outcome,
    calls: record.usage.length,
    inputTokens: sum((row) => row.input_tokens),
    outputTokens: sum((row) => row.output_tokens),
    cachedInputTokens: sum((row) => row.cached_input_tokens),
    costUsd: roundUsd(sum((row) => row.cost_usd)),
    parts: record.context_parts.map((part) => ({ name: part.name, tokens: part.tokens, trimmed: part.trimmed })),
    repairs,
  };
}

export function transcriptOf(turns: { input: string; lines: ShownLine[] }[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const turn of turns) {
    if (turn.input !== OPENING_INPUT && turn.input.trim().length > 0) {
      out.push({ kind: "player", text: turn.input });
    }
    for (const line of turn.lines) out.push(line);
  }
  return out;
}

export function messageCount(turn: { input: string; lines: ShownLine[] }): number {
  const player = turn.input !== OPENING_INPUT && turn.input.trim().length > 0 ? 1 : 0;
  return player + turn.lines.length;
}

/**
 * The newest whole turns that fill about `messages` lines.
 * `moreBefore` means turns exist older than `turns[0]`, even though they were not passed in.
 * A turn is kept whole, so the page can run a few lines past `messages`.
 */
export function tailWindow<T extends { id: string; input: string; lines: ShownLine[] }>(
  turns: readonly T[],
  messages: number,
  moreBefore: boolean,
): { turns: T[]; before: string | null } {
  if (turns.length === 0) return { turns: [], before: null };
  const limit = Math.max(1, messages);
  let count = 0;
  let start = turns.length;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn) break;
    count += messageCount(turn);
    start = i;
    if (count >= limit) break;
  }
  const page = turns.slice(start);
  const oldest = page[0]?.id;
  const olderExists = start > 0 || moreBefore;
  return { turns: page, before: olderExists && oldest ? oldest : null };
}

/** The sentence to show when a request fails. Unwraps the `{ error: true, data: { error } }` envelope. */
export function faultMessage(err: unknown): string {
  return readFault(err) ?? "That did not go through. Try again in a moment.";
}

function readFault(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "true" || text === "Request failed") return null;
    return text;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") {
    const text = record.error.trim();
    if (text && text !== "true") return text;
  }
  for (const key of ["data", "cause"]) {
    const nested = readFault(record[key], depth + 1);
    if (nested) return nested;
  }
  if (typeof record.statusMessage === "string") {
    const text = record.statusMessage.trim();
    if (text && text !== "Request failed" && text !== "true") return text;
  }
  if (typeof record.message === "string") {
    const text = record.message.trim();
    if (text && text !== "Request failed" && text !== "true") return text;
  }
  return null;
}

/** The latest line the player typed, skipping the dealt opening. */
export function lastPlayerTurn<T extends { input: string }>(turns: T[]): T | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn && turn.input !== OPENING_INPUT) return turn;
  }
  return null;
}

export function richText(text: string): { bold: boolean; text: string }[] {
  const parts: { bold: boolean; text: string }[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ bold: false, text: text.slice(last, index) });
    parts.push({ bold: true, text: match[1] ?? "" });
    last = index + match[0].length;
  }
  if (last < text.length || parts.length === 0) parts.push({ bold: false, text: text.slice(last) });
  return parts;
}
