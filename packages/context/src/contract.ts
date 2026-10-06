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

export function outputFormatText(order: OutputOrder, config?: Config): string {
  const keys =
    order === "delta_first"
      ? "Write the keys in this order: delta, beat, narration (the delta is checked first)."
      : "Write the keys in this order: narration, delta, beat.";
  const lines = [
    "OUTPUT",
    "Reply with a single JSON object only. No prose, no code fences.",
    "Write the narration once, inside the JSON. Never write the story as plain text as well.",
    'Optional keys: "focus_next", "need", "check" only with the fate die, "scene_ended" with "chapter_title", "at" where travel stops, "highlights" (up to 4 new names), "suggested_actions" (up to 3 short offers).',
  ];
  if (config?.notes.enabled) lines.push('Optional "notes": short private strings (see NOTES).');
  lines.push(keys);
  return lines.join("\n");
}

export function sceneText(config: Config): string {
  return `- You alone end a scene, with "scene_ended": true and a short "chapter_title", when the player leaves, sleeps, the talk is over, or the errand is done. The engine will not infer it. Never set it mid-task. After about ${config.scenes.max_beats} turns memory is tidied anyway.`;
}

export function notesText(config: Config): string {
  return `- "notes" are private. The newest ${config.notes.max_in_context} return under YOUR PRIVATE NOTES and expire after ${config.notes.ttl_turns} turns. Never show them. If one still matters, open a thread.`;
}

const VIOLENCE: Record<string, string> = {
  deflect:
    "- The player may attempt violence; you never narrate the injury. It misses or is blocked for a physical reason. People react. Open a thread for the fallout.",
  consequence:
    "- The player may attempt violence and it lands. One or two clauses, then move on: no gore. The world answers immediately. Put the cost in the delta.",
  adventure:
    "- This is an adventure: fights are part of the genre. Blows land, people are wounded, and characters can die. No lingering on gore. Put every injury in the delta.",
};

const HARSHNESS: Record<string, string> = {
  forgiving: "- Consequences are gentle. Mistakes cost a little and can be walked back.",
  normal: "- Consequences are realistic. Mistakes cost something that has to be dealt with.",
  unforgiving: "- Consequences are heavy. Mistakes cost money, standing, health or a relationship, and they stick.",
};

/** Travel sentences from this book's own words. A book with no journeys and no local steps adds none. */
export function travelLines(config: Config): string[] {
  const lines = [
    '- Set "at" to the player\'s place id. The engine creates it if new and moves them this turn. A person, town, outside, upstairs, downstairs, inside, or home is not a place unless the sheet names it.',
  ];
  const journeys = config.travel.journeys;
  const local = config.travel.local;
  if (journeys.length > 0) {
    const sample = journeys[0] ?? "leave";
    lines.push(`- In this book these also count as a trip: ${journeys.join(", ")}. With these, "for" counts as well ("${sample} for").`);
  }
  if (local.length > 0) {
    lines.push(`- These are a few steps inside the current place, not a new place: ${local.join(", ")}.`);
  }
  return lines;
}

export function fateText(config: Config): string {
  const lines = [
    "- A risky action uses the supplied FATE DIE. Hard work spends energy with stat.add. Set \"check\" when you use the die.",
  ];
  if (config.dice?.visible) {
    lines.push("- The player sees the roll, so a low roll must visibly go wrong and a high roll must visibly go well.");
    if (config.dice.stat_modifier) {
      lines.push('- Name the stat the check leans on in "check".stat. A strong stat should carry a middling roll; a weak one should not.');
    }
  } else {
    lines.push(
      "- The player does NOT see the roll. Never mention dice, odds or luck. When an action fails or half-works, give a concrete in-world reason the player can see.",
    );
  }
  return lines.join("\n");
}

export function timeText(config: Config): string {
  const lines = [
    `- Elapsed time is clock.advance (minutes) or clock.skip with a reason, up to ${config.time.max_skip_minutes} minutes. A stated time is the clock. clock.set may be earlier. Do not skip past something urgent.`,
  ];
  if (config.time.max_skip_minutes === 0) lines.push("- This character does not skip time. Play the hours through.");
  if (config.time.rest_note) lines.push(`- Rest in this world: ${config.time.rest_note}`);
  return lines.join("\n");
}

export function threadText(config: Config): string {
  const majors = config.threads.max_majors;
  return [
    "- A thread's scale is potential, minor or major. Never say those words to the player.",
    `- At most ${majors} majors and ${config.threads.max_in_context} threads are shown, not all of them: last ${config.threads.rewarm_hours} hours, their place, a name just used, or a close deadline. A person merely in the room does not bring one in.`,
    `- "potential" is an offer this turn. It lapses after ${config.threads.potential_hours} hours. thread.adopt to "minor" only when the player takes it up.`,
    `- A long matter is "major". At most ${majors} lead. Opening another flags the quiet one set aside. Mention it once, then leave it. If they keep ignoring it, its deadline still happens. A child sets parent. Resolving a major leaves its minors open.`,
    "- Do not reopen an open thread, or one resolved in the last 48 hours. A named weekday is that weekday on due. A figure in a thread is not the balance. Do not nag.",
  ].join("\n");
}

function payKey(config: Config): string {
  const keys = config.stats.filter((stat) => stat.type === "currency").map((stat) => stat.key);
  if (keys.includes("cash")) return "cash";
  return keys[0] ?? "money";
}

function workedExamples(config: Config, modules: Module[]): string {
  const lines = [
    "EXAMPLES",
    '{"op":"entity.fact.add","id":"<person id who witnessed it>","fact":"Heard you promise to bring the mower back by four","importance":2}',
  ];
  if (modules.some((m) => m.ops.includes("inventory.add"))) {
    const item =
      config.items.find((candidate) => candidate.price !== undefined && candidate.price > 0 && !/wallet|purse/.test(candidate.id)) ??
      config.items.find((candidate) => candidate.price !== undefined) ??
      config.items[0];
    if (item && item.price !== undefined && item.price > 0 && modules.some((m) => m.ops.includes("stat.add"))) {
      lines.push(`{"op":"inventory.add","owner":"${config.player_id}","item":"${item.id}","qty":1}`);
      lines.push(`{"op":"stat.add","key":"${payKey(config)}","amount":-${item.price},"reason":"${item.name}"}`);
    } else {
      lines.push(
        item
          ? `{"op":"inventory.add","owner":"${config.player_id}","item":"${item.id}","qty":1}`
          : `{"op":"inventory.add","owner":"${config.player_id}","item":"<catalog item id>","qty":1}`,
      );
    }
  }
  return lines.join("\n");
}

function purchaseLines(config: Config, modules: Module[]): string[] {
  if (!modules.some((m) => m.ops.includes("inventory.add"))) return [];
  const key = payKey(config);
  return [
    "- Gear is kept. Goods are used in the scene. Copy the id. A bag, a receipt, or an envelope is narration. Do not create it and do not add it.",
    "- A new thing the save must remember is item.create this turn (keeps true for gear, a price when sold), then inventory.add. A good eaten, drunk, handed over, or set down is inventory.remove that turn. Gear stays until it is lost.",
    `- A purchase is inventory.add of that one catalog item to "${config.player_id}" and stat.add of its price as a negative amount on "${key}". An item on that line is already bought. Charge the stated figure, a whole unit, or narrate the refusal. Nothing is no stat.add.`,
  ];
}

function balanceLine(config: Config): string {
  const keys = config.stats.filter((stat) => stat.type === "currency").map((stat) => stat.key);
  if (keys.includes("cash") && keys.includes("bank")) {
    return "- Cash and the bank balance are currency stats. The wallet is one object. Notes are stat.add on cash. The card is stat.add on bank. Never store notes as a pile of objects.";
  }
  return "- A currency balance is the currency stat in STATE. Never store money as a pile of objects.";
}

export function contractText(config: Config, modules: Module[], order: OutputOrder): string {
  const style = config.gm_style;
  const tabletop = config.presentation.profile === "tabletop";
  const lines: string[] = [
    "You are the Game Master. Code owns the truth: you narrate and propose changes, code validates and applies them.",
    `Game: ${config.meta.title}. Tone: ${config.meta.tone}.${config.meta.premise ? ` Premise: ${config.meta.premise}` : ""}`,
    `The player character id is "${config.player_id}".`,
    "",
    "RULES",
    "- You never write state. You propose `delta` ops. Every change to money, stats, items, time, relationships, threads or new named characters MUST appear in delta. If it is not in delta, it did not happen.",
    "- entity.create a new person or place before any op refers to it. Use only ids in the context.",
    "- Other people know only what they have seen, heard, or been told. If it would change a later scene, add one entity.fact.add. A passing remark gets nothing. importance 1 fades in a day, 2 in a week, and importance 3 is a fight, a betrayal, or real harm. A stated memory is already on them, or you add it because they witnessed it.",
    "- ENGINE NOW is the save. It wins over LAST TURNS and STORY SO FAR on money, place, time, and what is carried. **Bold** in LAST TURNS is new: create it.",
    ...travelLines(config),
    '- Refuse a trip once, and give the reason. If they ask again, entity.create if needed, entity.move, and set "at". A second refusal is not allowed.',
    "- If the narration buys, orders, eats, drinks, or puts down a catalog item, the same delta records it. Otherwise do not narrate it.",
    ...purchaseLines(config, modules),
    balanceLine(config),
    "- Stat keys are the ids in brackets in STATE, not the labels. Do not name a person tagged unmet until they share the player's location.",
    tabletop
      ? "- Stat numbers and rolls may appear in narration (tabletop profile)."
      : "- Never write the status line or stat numbers in narration; the engine renders them.",
    '- Handle several actions in order. Input "..." (kind continue) advances from DUE EVENTS.',
    "",
    "TIME",
    timeText(config),
    "",
    "OUTCOMES",
    fateText(config),
    VIOLENCE[config.meta.violence] ?? VIOLENCE.deflect ?? "",
    HARSHNESS[config.meta.harshness] ?? HARSHNESS.normal ?? "",
    "",
    "THREADS",
    threadText(config),
    "",
    "SCENES",
    sceneText(config),
    "",
    "STYLE",
    `- At most ${style.max_words} words of narration, in ${PERSON[style.person] ?? style.person}.`,
  ];
  if (style.never_decide_for_player) {
    lines.push("- Never decide the player's actions, words or feelings; stop where the player chooses.");
  }
  for (const rule of style.extra_rules) lines.push(`- ${rule}`);
  if (config.notes.enabled) lines.push("", "NOTES", notesText(config));
  lines.push(
    "",
    workedExamples(config, modules),
    "",
    "CONTENT",
    RATING[config.meta.content_rating] ?? RATING.clean ?? "",
    "Never write any sexual content involving minors.",
    "",
    "OPS",
    describeOps(modules),
    "",
    outputFormatText(order, config),
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
  // Both blocks are the static prefix. ENGINE NOW and LAST TURNS are in the user message, after this prefix.
  const system: LLMSystemBlock[] = [{ text: contract, cache: true }];
  if (frag.text) system.push({ text: frag.text, cache: true });
  return { system, contract, fragments: frag.text, fragmentsTrimmed: frag.trimmed };
}
