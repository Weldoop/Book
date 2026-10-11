import { emphasize, endingLines, rollLine, sceneLine, usageLine } from "@book/harness";
import type { PresentationProfile } from "@book/schema";
import type { TurnResult } from "@book/runtime";

export interface ConsoleLine {
  kind: "story" | "status" | "note" | "error";
  text: string;
}

export interface Presented {
  lines: ConsoleLine[];
  suggestions: string[];
  ended: boolean;
}

/** The same page the terminal prints, as lines a phone can scroll. `/quit` is `/new` here. */
export function presentTurn(result: TurnResult, opts: { profile: PresentationProfile; wallMs: number }): Presented {
  const lines: ConsoleLine[] = [];
  const roll = rollLine(result);
  if (roll) lines.push({ kind: "note", text: roll });
  if (result.interlude?.trim()) lines.push({ kind: "note", text: result.interlude });
  const story = emphasize(result.narration, result.highlights, false);
  if (story.trim()) lines.push({ kind: "story", text: story });
  for (const notice of result.notices) {
    if (notice.trim()) lines.push({ kind: "note", text: notice });
  }
  if (result.status) lines.push({ kind: "status", text: result.status });
  if (opts.profile === "tabletop") {
    for (const row of result.panel) lines.push({ kind: "note", text: `  ${row}` });
  }
  const scene = sceneLine(result);
  if (scene) lines.push({ kind: "note", text: scene });
  for (const line of endingLines(result)) {
    lines.push({ kind: "story", text: line.replaceAll("/quit", "/new") });
  }
  if (result.record.usage.length > 0) lines.push({ kind: "note", text: `[${usageLine(result, opts.wallMs)}]` });
  const suggestions = result.suggestions?.map((item) => item.trim()).filter((item) => item.length > 0) ?? [];
  const ended = result.outcome === "ended" || Boolean(result.ending && !result.ending.continuation);
  return { lines, suggestions, ended };
}
