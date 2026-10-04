import type { Config, LLMSystemBlock, Module } from "@book/schema";
import { describeOps } from "./ops.ts";
import type { OutputOrder } from "./types.ts";

const PERSON: Record<string, string> = {
  first: "first person (I)",
  second: "second person (you)",
  third: "third person",
};

const RATING: Record<string, string> = {
  clean: "Content rating: clean. No sexual content. Affection stays non-sexual.",
  romance: "Content rating: romance. Romance is allowed; anything explicit fades to black.",
  mature: "Content rating: mature. Mature themes are allowed within the model provider's usage policy.",
};

export function outputFormatText(order: OutputOrder): string {
  const keys =
    order === "delta_first"
      ? "Write the keys in this order: delta, beat, narration (the delta is checked first)."
      : "Write the keys in this order: narration, delta, beat.";
  return [
    "OUTPUT",
    "Reply with a single JSON object only. No prose, no code fences. Keys:",
    '- "narration": string, the story text for the player.',
    '- "delta": array of ops (use [] if nothing changed).',
    '- "beat": one line, at most 20 words, summarising what happened.',
    '- "focus_next": optional array of entity ids likely to matter next turn.',
    '- "need": optional array of ids you lack information on.',
    keys,
  ].join("\n");
}

export function contractText(config: Config, modules: Module[], order: OutputOrder): string {
  const style = config.gm_style;
  const tabletop = config.presentation.profile === "tabletop";
  const lines: string[] = [
    "You are the Game Master of an interactive story. Code owns the truth: you narrate and propose changes, code validates and applies them.",
    `Game: ${config.meta.title}. Tone: ${config.meta.tone}.${config.meta.premise ? ` Premise: ${config.meta.premise}` : ""}`,
    `The player character id is "${config.player_id}".`,
    "",
    "RULES",
    "- You never write state. You propose `delta` ops.",
    "- Every change to money, stats, items, time, relationships, threads or new named characters MUST appear in delta. If it is not in delta, it did not happen.",
    "- Elapsed time goes in delta as clock.advance (minutes).",
    "- Declare every new named person or place with entity.create before any op or focus_next refers to it.",
    "- Use only ids shown in the context. Never invent ops or fields.",
    tabletop
      ? "- Stat numbers and rolls may appear in narration (tabletop profile)."
      : "- Never write the status line or stat numbers in narration; the engine renders them.",
    "- The player's message may contain several actions: handle them in order in one narration.",
    "- When a risky action needs a result, use the supplied FATE DIE value instead of inventing the outcome.",
    '- If the input is "..." (kind continue), advance the scene using DUE EVENTS or natural progression.',
    "",
    "STYLE",
    `- At most ${style.max_words} words of narration, in ${PERSON[style.person] ?? style.person}.`,
  ];
  if (style.never_decide_for_player) {
    lines.push("- Never decide the player's actions, words or feelings; stop where the player chooses.");
  }
  for (const rule of style.extra_rules) lines.push(`- ${rule}`);
  lines.push(
    "",
    "CONTENT",
    RATING[config.meta.content_rating] ?? RATING.clean ?? "",
    "Never write any sexual content involving minors.",
    "",
    "OPS",
    describeOps(modules),
    "",
    outputFormatText(order),
  );
  return lines.join("\n");
}

/** Block 2: prompt fragments of the active modules, sorted by id so the text is stable. */
export function moduleFragmentsText(
  config: Config,
  modules: Module[],
  cap: number,
): { text: string; trimmed: boolean } {
  const fragments = [...modules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => m.promptFragment(config).trim())
    .filter((f) => f.length > 0);
  const header = "MODULE RULES";
  let kept = fragments;
  const render = (): string => (kept.length === 0 ? "" : [header, ...kept].join("\n\n"));
  while (kept.length > 0 && Math.ceil(render().length / 4) > cap) kept = kept.slice(0, -1);
  return { text: render(), trimmed: kept.length < fragments.length };
}

export interface StaticBlocks {
  system: LLMSystemBlock[];
  contract: string;
  fragments: string;
  fragmentsTrimmed: boolean;
}

export function buildStaticBlocks(
  config: Config,
  modules: Module[],
  order: OutputOrder,
  fragmentCap: number,
): StaticBlocks {
  const contract = contractText(config, modules, order);
  const frag = moduleFragmentsText(config, modules, fragmentCap);
  const system: LLMSystemBlock[] = [{ text: contract, cache: true }];
  if (frag.text) system.push({ text: frag.text, cache: true });
  return { system, contract, fragments: frag.text, fragmentsTrimmed: frag.trimmed };
}
