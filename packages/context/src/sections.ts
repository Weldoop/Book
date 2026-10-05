import { diffMinutes, humanTime } from "@book/engine";
import type { Config, DueItem, Entity, Fact, Module, State } from "@book/schema";
import { orderThreads, selectThreads } from "./attention.ts";
import { MAX_BEATS, MAX_FACTS_PER_ENTITY_IN_CONTEXT, WINDOW_TURNS } from "./budget.ts";
import { dayOfWeek, fitLines, renderSection, tokensOf, trimOldestSentences } from "./text.ts";

export interface Section {
  text: string;
  trimmed: boolean;
}

const EMPTY: Section = { text: "", trimmed: false };

const TYPE_RANK: Record<string, number> = { person: 0, faction: 1, other: 2, item: 3, place: 4 };

const MAX_THREADS = 12;

function nameOf(state: State, id: string): string {
  return state.entities[id]?.name ?? id;
}

export function sceneSection(config: Config, state: State): Section {
  const now = state.clock.now;
  const dow = dayOfWeek(now);
  const player = state.entities[config.player_id];
  const locId = player?.location ?? null;
  const sceneTurns = state.turn - state.scene.started_turn;
  const lines = [
    `Scene ${state.scene.index}, running ${sceneTurns} turn${sceneTurns === 1 ? "" : "s"}`,
    `Now: ${now}${dow ? ` (${dow})` : ""}`,
  ];
  if (locId) {
    lines.push(`Location: ${nameOf(state, locId)} [${locId}]`);
    const present = Object.values(state.entities)
      .filter((e) => e.location === locId && e.id !== config.player_id && !e.tags.includes("unmet"))
      .sort((a, b) => (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) || a.id.localeCompare(b.id));
    if (present.length > 0) lines.push(`Present: ${present.map((e) => `${e.name} [${e.id}]`).join(", ")}`);
  } else {
    lines.push("Location: unknown");
  }
  return { text: renderSection("## SCENE", lines), trimmed: false };
}

export function stateSection(config: Config, state: State, modules: Module[], cap: number): Section {
  const lines: string[] = [];
  for (const m of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const l of m.snapshot(state, config)) if (l.trim()) lines.push(l);
  }
  const fit = fitLines("## STATE", lines, cap, "end");
  return { text: renderSection("## STATE", fit.lines), trimmed: fit.trimmed };
}

export function dueSection(config: Config, due: DueItem[], fate: number | undefined, cap: number): Section {
  const items = due.map((d) => `- [${d.id}] ${d.text}${d.entities.length ? ` (${d.entities.join(", ")})` : ""}`);
  const fateLine =
    fate === undefined ? "" : `FATE DIE: ${fate}${config.dice ? ` (d${config.dice.sides})` : ""}`;
  if (items.length === 0 && !fateLine) return EMPTY;
  const header = items.length > 0 ? "## DUE EVENTS" : "## FATE DIE";
  const reserve = fateLine ? fateLine.length + 1 : 0;
  const fit = fitLines(header, items, cap - Math.ceil(reserve / 4), "end");
  const lines = fateLine ? [...fit.lines, fateLine] : fit.lines;
  return { text: renderSection(header, lines), trimmed: fit.trimmed };
}

/** Every open thread, for out-of-character recall ("what am I meant to be doing?"). Costs a cheap call only. */
export function allThreadsSection(state: State, cap: number): Section {
  const ordered = orderThreads(state.threads.filter((t) => t.scale !== "potential"));
  const lines = ordered.slice(0, MAX_THREADS).map((t) => {
    const due = t.due ? ` due ${t.due}` : "";
    return `- ${t.id} [${t.kind}]${due}: ${t.text}`;
  });
  const fit = fitLines("## OPEN THREADS", lines, cap, "end");
  return { text: renderSection("## OPEN THREADS", fit.lines), trimmed: fit.trimmed || ordered.length > MAX_THREADS };
}

export interface ThreadsSection extends Section {
  /** Ids rendered, so the engine can count the reminder against them. */
  shown: string[];
}

export function threadsSection(state: State, config: Config, input: string, cap: number): ThreadsSection {
  const chosen = selectThreads(state, config, input);
  const lines = chosen.map((t) => {
    const due = t.due ? ` due ${t.due}` : "";
    const aside = t.scale === "minor" && t.was_major ? " set aside" : "";
    const ents = t.entities.length ? ` (${t.entities.join(", ")})` : "";
    return `- ${t.id} [${t.kind}/${t.scale}]${aside}${due}: ${t.text}${ents}`;
  });
  const fit = fitLines("## OPEN THREADS", lines, cap, "end");
  const openCount = state.threads.filter((t) => t.status === "open").length;
  return {
    text: renderSection("## OPEN THREADS", fit.lines),
    trimmed: fit.trimmed || openCount > chosen.length,
    shown: chosen.slice(0, fit.lines.length).map((t) => t.id),
  };
}

/**
 * The GM's own notes from the last few turns. Private: this section exists so the GM can set up a
 * payoff, and it is the one part of the context that is never rendered to the player.
 */
export function notesSection(state: State, config: Config, cap: number): Section {
  if (!config.notes.enabled || state.notes.length === 0) return EMPTY;
  const lines = [...state.notes]
    .sort((a, b) => b.turn - a.turn)
    .slice(0, config.notes.max_in_context)
    .map((n) => `- t${n.turn}: ${n.text}`);
  const fit = fitLines("## YOUR PRIVATE NOTES", lines, cap, "end");
  return { text: renderSection("## YOUR PRIVATE NOTES", fit.lines), trimmed: fit.trimmed };
}

interface FocusEntry {
  entity: Entity;
  facts: Fact[];
}

function factOrder(a: Fact, b: Fact): number {
  return b.importance - a.importance || b.turn - a.turn;
}

/** A person's memory that has already lapsed stays out of the prompt. */
function liveFacts(entity: Entity, now: string): Fact[] {
  return entity.facts.filter((fact) => fact.expires === undefined || diffMinutes(now, fact.expires) < 0);
}

function focusLine(state: State, entry: FocusEntry): string {
  const e = entry.entity;
  const where = e.location ? ` @ ${nameOf(state, e.location)}` : "";
  const aka = e.aliases.length ? `; aka ${e.aliases.join(", ")}` : "";
  const remembered = entry.facts.map((f) => f.text).join("; ");
  const facts = remembered ? (e.type === "person" ? ` remembers: ${remembered}` : `: ${remembered}`) : "";
  return `- ${e.name} [${e.id}] (${e.type}${where}${aka})${facts}`;
}

export function focusSection(
  state: State,
  ids: string[],
  cap: number,
): { section: Section; shown: string[] } {
  const header = "## FOCUS ENTITIES";
  let trimmed = false;
  let entries: FocusEntry[] = [];
  for (const id of ids) {
    const entity = state.entities[id];
    if (!entity) continue;
    const sorted = liveFacts(entity, state.clock.now).sort(factOrder);
    if (sorted.length > MAX_FACTS_PER_ENTITY_IN_CONTEXT) trimmed = true;
    entries.push({ entity, facts: sorted.slice(0, MAX_FACTS_PER_ENTITY_IN_CONTEXT) });
  }
  const render = (): string => renderSection(header, entries.map((e) => focusLine(state, e)));

  while (entries.length > 0 && tokensOf(render()) > cap) {
    trimmed = true;
    let victim = -1;
    for (let i = 0; i < entries.length; i++) {
      const facts = entries[i]?.facts ?? [];
      if (facts.length <= 1) continue;
      const tail = facts[facts.length - 1];
      const cur = victim >= 0 ? entries[victim]?.facts.at(-1) : undefined;
      if (!tail) continue;
      if (
        !cur ||
        tail.importance < cur.importance ||
        (tail.importance === cur.importance && tail.turn <= cur.turn)
      ) {
        victim = i;
      }
    }
    if (victim >= 0) entries[victim]?.facts.pop();
    else entries = entries.slice(0, -1);
  }
  return {
    section: { text: render(), trimmed },
    shown: entries.map((e) => e.entity.id),
  };
}

export function storySection(state: State, cap: number): Section {
  const story = state.summaries.story_so_far.trim();
  if (!story) return EMPTY;
  const header = "## STORY SO FAR";
  const fit = trimOldestSentences(story, cap - Math.ceil((header.length + 1) / 4));
  return { text: `${header}\n${fit.text}`, trimmed: fit.trimmed };
}

export function recentBeats(state: State): { turn: number; text: string }[] {
  return state.beats.filter((b) => b.turn > state.summaries.last_compacted_turn);
}

export function beatsSection(state: State, cap: number): Section {
  const all = recentBeats(state);
  const recent = all.slice(-MAX_BEATS);
  const lines = recent.map((b) => `- t${b.turn}: ${b.text}`);
  const fit = fitLines("## RECENT BEATS", lines, cap, "start");
  return {
    text: renderSection("## RECENT BEATS", fit.lines),
    trimmed: fit.trimmed || all.length > recent.length,
  };
}

export function windowSection(state: State, cap: number): Section {
  const header = "## LAST TURNS";
  const turns = state.window.slice(-WINDOW_TURNS);
  const lines = turns.map((t) => `Player: ${t.input}\nGM: ${t.narration}`);
  const fit = fitLines(header, lines, cap, "start");
  if (fit.lines.length === 0 && lines.length > 0) {
    const last = turns[turns.length - 1];
    if (last) {
      const prefix = `Player: ${last.input}\nGM: …`;
      const room = Math.max(0, cap * 4 - header.length - 1 - prefix.length);
      const tail = last.narration.slice(Math.max(0, last.narration.length - room));
      return { text: `${header}\n${prefix}${tail}`, trimmed: true };
    }
  }
  return {
    text: renderSection(header, fit.lines),
    trimmed: fit.trimmed || state.window.length > turns.length,
  };
}

/**
 * The save, placed after the verbatim turns so a stale line in that window cannot outrank it.
 * The status figures are the ones the player is shown. Carrying is included because narration
 * was leaving items behind that the save still held.
 */
export function engineNowSection(config: Config, state: State, modules: Module[]): Section {
  const lines = [
    "Factual. This is the save. LAST TURNS may quote an older balance, place, or item. If they disagree, these lines win. Do not narrate a different one.",
  ];
  const player = state.entities[config.player_id];
  const locId = player?.location ?? null;
  const place = locId ? state.entities[locId] : undefined;
  lines.push(place ? `Location: ${place.name} [${place.id}]` : "Location: unknown");

  const status: string[] = [];
  for (const key of config.presentation.status_line) {
    if (key === "turn") status.push(`Turn ${state.turn}`);
    else if (key === "time") status.push(humanTime(state.clock.now));
    else if (key === "location" && place) status.push(place.name);
  }
  const carried: string[] = [];
  for (const m of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const line of m.truth?.(state, config) ?? []) {
      if (!line.trim()) continue;
      if (line.startsWith("Carrying:")) carried.push(line);
      else status.push(line);
    }
  }
  if (status.length > 0) lines.push(status.join(" | "));
  lines.push(...carried);
  return { text: renderSection("## ENGINE NOW", lines), trimmed: false };
}

export function inputSection(input: string, kind: "act" | "continue"): Section {
  const body = input.trim() === "" ? "..." : input;
  const hint = kind === "continue" ? "\n(continue: advance the scene)" : "";
  return { text: `## PLAYER INPUT\n${body}${hint}`, trimmed: false };
}
