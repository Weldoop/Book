import { estimateTokens } from "@book/schema";

export interface Fitted {
  lines: string[];
  trimmed: boolean;
}

/**
 * Keeps as many lines as fit `cap` tokens once joined under `header`.
 * `drop` says which end loses lines first. Length maths mirrors estimateTokens.
 */
export function fitLines(header: string, lines: string[], cap: number, drop: "start" | "end"): Fitted {
  let total = header.length;
  for (const l of lines) total += l.length + 1;
  let start = 0;
  let end = lines.length;
  while (end > start && Math.ceil(total / 4) > cap) {
    if (drop === "end") {
      end -= 1;
      total -= (lines[end] ?? "").length + 1;
    } else {
      total -= (lines[start] ?? "").length + 1;
      start += 1;
    }
  }
  return { lines: lines.slice(start, end), trimmed: end - start < lines.length };
}

export function renderSection(header: string, lines: string[]): string {
  return lines.length === 0 ? "" : [header, ...lines].join("\n");
}

export function tokensOf(text: string): number {
  return estimateTokens(text);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word matcher; null for terms too short to match safely. */
export function wordMatcher(term: string): RegExp | null {
  const t = term.trim();
  if (t.length < 2) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(t)}(?![\\p{L}\\p{N}_])`, "iu");
}

/** Drops the oldest sentences until the text fits the cap; hard-cuts the head as a last resort. */
export function trimOldestSentences(text: string, capTokens: number): { text: string; trimmed: boolean } {
  const clean = text.trim();
  if (estimateTokens(clean) <= capTokens) return { text: clean, trimmed: false };
  const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  let start = 0;
  let total = clean.length;
  while (sentences.length - start > 1 && Math.ceil(total / 4) > capTokens) {
    total -= (sentences[start] ?? "").length + 1;
    start += 1;
  }
  let out = sentences.slice(start).join(" ");
  const maxChars = capTokens * 4;
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return { text: out, trimmed: true };
}

/** Finds the first parseable JSON object in text that may contain fences or prose. */
export function extractJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  const attempt = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = attempt(trimmed);
  if (direct !== undefined && typeof direct === "object" && direct !== null) return direct;

  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  for (let m = fence.exec(trimmed); m !== null; m = fence.exec(trimmed)) {
    const v = attempt((m[1] ?? "").trim());
    if (v !== undefined && typeof v === "object" && v !== null) return v;
  }

  for (let i = trimmed.indexOf("{"); i !== -1; i = trimmed.indexOf("{", i + 1)) {
    const end = matchingBrace(trimmed, i);
    if (end === -1) continue;
    const v = attempt(trimmed.slice(i, end + 1));
    if (v !== undefined && typeof v === "object" && v !== null) return v;
  }
  return undefined;
}

function matchingBrace(s: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function dayOfWeek(local: string): string | null {
  const d = new Date(`${local}:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()] ?? null;
}
