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
    "Reply with a single JSON object only. No prose, no code fences, no commentary before or after it.",
    "Write the narration once, inside the JSON. Never write the story as plain text as well.",
    "Keys:",
    '- "narration": string, the story text for the player.',
    '- "delta": array of ops (use [] if nothing changed).',
    '- "beat": one line, at most 20 words, summarising what happened.',
    '- "focus_next": optional array of entity ids likely to matter next turn.',
    '- "need": optional array of ids you lack information on.',
    '- "check": optional {"what": "what was at stake", "stat": "stat id from STATE"} - set this ONLY when you resolved the action with the fate die. Omit stat if you have no skill to name.',
    '- "scene_ended": optional true - set this ONLY when the scene has just come to a natural close.',
    '- "at": optional place id. Set it to where the narration stops whenever anyone travels.',
  ];
  if (config?.notes.enabled) {
    lines.push('- "notes": optional array of short private strings, for your eyes only (see NOTES).');
  }
  lines.push(keys);
  return lines.join("\n");
}

export function sceneText(config: Config): string {
  return [
    "- A scene is one continuous stretch of story: a place, a conversation, a job of work. SCENE says which one you are in and how long it has run.",
    "- You alone decide when a scene ends. Set \"scene_ended\": true on the turn it closes: the player leaves, sleeps, the conversation is over, or the errand is done. The engine will not infer this from travel or sleep.",
    `- Never set it mid-conversation or mid-task because a turn felt finished. After about ${config.scenes.max_beats} turns the engine tidies memory anyway, without pretending the scene ended.`,
  ].join("\n");
}

export function notesText(config: Config): string {
  return [
    `- You may add short private notes in "notes": a secret the player has not found, a turn you mean to take soon, a detail to pay off. The newest ${config.notes.max_in_context} come back under YOUR PRIVATE NOTES.`,
    "- They are never shown to the player. Never mention or quote them, and never write them into the narration.",
    `- They expire after ${config.notes.ttl_turns} turns. If one still matters, make it real: open a thread, or add an entity fact. A note is a reminder to yourself; a thread is a promise to the story.`,
  ].join("\n");
}

const VIOLENCE: Record<string, string> = {
  deflect: [
    "- The player may attempt violence; you never narrate the injury. The attempt misses, is blocked, is flinched away from, or lands harmlessly, for a concrete physical reason.",
    "- Make it cost them instead: people react, leave, call someone, stop trusting them, and the trouble follows. Open a thread for the fallout and move relationships in the delta.",
  ].join("\n"),
  consequence: [
    "- The player may attempt violence and it lands. Report it plainly in one or two clauses and move on: no gore, no technique, no dwelling on pain or fear.",
    "- The world answers immediately and in proportion. Bystanders intervene, people call someone, and the authorities of this setting arrive on their own schedule.",
    "- The cost is the story: put the injury, the money, the standing and the trouble in the delta, and open a thread for what the player now has to live with.",
  ].join("\n"),
  adventure: [
    "- This is an adventure: fights are part of the genre. Blows land, people are wounded, and characters can die. Keep it swashbuckling, not gruesome; no lingering on gore or suffering.",
    "- Put every injury in the delta. Tag a killed character with entity.fact.add and stop referring to them as present.",
  ].join("\n"),
};

const HARSHNESS: Record<string, string> = {
  forgiving: "- Consequences are gentle. Mistakes cost a little and can be walked back.",
  normal: "- Consequences are realistic. Mistakes cost something that has to be dealt with.",
  unforgiving:
    "- Consequences are heavy. Mistakes cost money, standing, health or a relationship outright, and they stick.",
};

/** Travel sentences from this book's own words. A book with no journeys and no local steps adds none. */
export function travelLines(config: Config): string[] {
  const lines = [
    "- If the player goes somewhere, entity.move the player in that same delta. Create a new place with entity.create before the move. A place someone mentions before the player enters it is created in that turn with the tag \"unvisited\".",
  ];
  const journeys = config.travel.journeys;
  const local = config.travel.local;
  if (journeys.length > 0) {
    const sample = journeys[0] ?? "leave";
    lines.push(
      `- In this book these also count as a trip: ${journeys.join(", ")}. With these, "for" counts as well ("${sample} for").`,
    );
  }
  if (local.length > 0) {
    lines.push(`- These are a few steps inside the current place, not a new place: ${local.join(", ")}.`);
  }
  lines.push("- When anyone travels, set \"at\" to the place id where the narration stops.");
  return lines;
}

export function fateText(config: Config): string {
  const lines = [
    "- When a risky or uncertain action needs a result, use the supplied FATE DIE value instead of inventing the outcome. You decide whether an action is risky enough to need it; routine actions just succeed.",
    '- When you do use it, set "check" in the output so the engine can show the player what was rolled.',
  ];
  if (config.dice?.visible) {
    lines.push(
      "- The player sees the roll, so the narration must match it: a low roll must visibly go wrong and a high roll must visibly go well.",
    );
    if (config.dice.stat_modifier) {
      lines.push(
        '- Name the stat the check leans on in "check".stat. A strong stat should carry a middling roll; a weak one should not.',
      );
    }
  } else {
    lines.push(
      "- The player does NOT see the roll. Never mention dice, odds or luck. When an action fails or half-works, the narration must give a concrete in-world reason the player can see - someone saw it coming, a hand was wet, a drawer stuck. Never let an attempt simply fizzle with no stated cause.",
    );
  }
  return lines.join("\n");
}

export function timeText(config: Config): string {
  const lines = [
    "- Elapsed time goes in delta as clock.advance (minutes).",
    `- For a deliberate stretch of sleeping, travelling or waiting, use clock.skip with a reason, up to ${config.time.max_skip_minutes} minutes in one turn.`,
    "- clock.advance covers one scene. A longer stretch that fits the skip cap is clock.skip, and the move stays in the same delta.",
  ];
  if (config.time.max_skip_minutes === 0) lines.push("- This character does not skip time. Play the hours through.");
  if (config.time.rest_note) lines.push(`- Rest in this world: ${config.time.rest_note}`);
  lines.push("- A skip must be plausible for this character and this world. Do not skip past something urgent.");
  return lines.join("\n");
}

export function threadText(config: Config): string {
  return [
    `- OPEN THREADS shows at most ${config.threads.max_in_context} of the live threads, not all of them. Threads the player ignores drop off this list and come back as consequences when their deadline passes.`,
    "- Thread the player caused and threads the world set matter equally. One action may resolve more than one: list every thread.resolve it earns.",
    "- When resolving a thread opens a new question, open the follow-up with thread.open and set parent to the thread it came from.",
    "- Do not open a thread that repeats one already open. The same deadline does not need a second thread.",
    "- Do not nag. Mention a thread only when the scene gives it a reason to come up.",
  ].join("\n");
}

function workedExamples(config: Config, modules: Module[]): string {
  const lines = [
    "EXAMPLES",
    `{"op":"entity.move","id":"${config.player_id}","location":"<place id from the world sheet>"}`,
    '{"op":"entity.create","id":"new-place","type":"place","name":"A place someone mentioned","tags":["unvisited"]}',
  ];
  if (modules.some((m) => m.ops.includes("inventory.add"))) {
    const item = config.items.find((i) => i.price !== undefined) ?? config.items[0];
    lines.push(
      item
        ? `{"op":"inventory.add","owner":"${config.player_id}","item":"${item.id}","qty":1}`
        : `{"op":"inventory.add","owner":"${config.player_id}","item":"<catalog item id>","qty":1}`,
    );
  }
  return lines.join("\n");
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
    "- Declare every new named person or place with entity.create before any op or focus_next refers to it.",
    "- Use only ids shown in the context. Never invent ops or fields. Item ids come from the world sheet.",
    "- Other people know only what they have seen, heard, or been told. An intention written only in the player's command is invisible to them until the player acts on it or says it.",
    ...travelLines(config),
    "- Refuse a trip once, and give the reason. If the player asks to leave again, create the place if it is not on the world sheet and entity.move them. A second refusal is not allowed.",
    "- If the narration buys, orders, eats, drinks, or puts down a catalog item, the same delta must record the inventory change and, for a purchase, the price. Otherwise do not narrate it.",
    "- A priced purchase charges a whole number of units, at least one, at the catalog price, and puts the item in the player's hands. Do not take a smaller sum. If they cannot afford one unit, narrate the refusal and leave the money where it is.",
    "- Stat keys are the ids in brackets in STATE, not the labels.",
    "- Do not name a person tagged unmet, and do not treat them as present, until they share the player's location.",
    tabletop
      ? "- Stat numbers and rolls may appear in narration (tabletop profile)."
      : "- Never write the status line or stat numbers in narration; the engine renders them.",
    "- The player's message may contain several actions: handle them in order in one narration.",
    '- If the input is "..." (kind continue), advance the scene using DUE EVENTS or natural progression.',
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
  lines.push("", workedExamples(config, modules), "", "CONTENT",
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
  const system: LLMSystemBlock[] = [{ text: contract, cache: true }];
  if (frag.text) system.push({ text: frag.text, cache: true });
  return { system, contract, fragments: frag.text, fragmentsTrimmed: frag.trimmed };
}
