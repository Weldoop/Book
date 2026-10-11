import type { Config, Entity, State, ThreadKind } from "@book/schema";
import { duplicateOpenThread } from "./threads.ts";

/** Commitments kept in the ledger. Name and alias lines are kept as well, and do not use these slots. */
export const LEDGER_CAP = 6;

const NOISE = new Set([
  "only",
  "just",
  "raining",
  "rain",
  "fine",
  "okay",
  "good",
  "bad",
  "late",
  "early",
  "cold",
  "hot",
  "nice",
  "the",
  "not",
  "all",
  "been",
  "going",
  "time",
  "about",
  "really",
  "quite",
  "very",
  "too",
  "well",
  "right",
  "true",
  "quid",
  "nothing",
  "something",
  "everything",
  "someone",
  "anyone",
  "pouring",
  "snowing",
  "windy",
  "sunny",
  "dark",
  "free",
  "worth",
  "ready",
  "done",
  "here",
  "there",
  "mine",
  "yours",
  "problem",
  "that",
  "this",
  "what",
  "when",
  "where",
  "your",
  "you",
]);

const PLACE_HEAD = new Set([
  "i",
  "im",
  "we",
  "you",
  "he",
  "she",
  "they",
  "go",
  "going",
  "look",
  "looking",
  "meet",
  "back",
  "sit",
  "stay",
  "get",
  "come",
  "coming",
  "and",
  "but",
  "the",
  "my",
  "our",
  "its",
  "it's",
]);

const TIME =
  "(?:\\d{1,2}(?::\\d{2})?(?:\\s*(?:am|pm))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";

export interface StatementHit {
  kind: "name" | "alias" | "commitment";
  text: string;
  name?: string;
  alias?: string;
  thread?: { kind: ThreadKind; text: string; entities: string[] };
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function properName(raw: string): string {
  const s = raw.trim();
  return s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase();
}

function noise(word: string): boolean {
  const w = word.toLowerCase();
  return w.length < 2 || NOISE.has(w) || (w.endsWith("ing") && w.length > 4);
}

function linesOf(input: string): string[] {
  return input
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function personByName(state: State, config: Config, raw: string): Entity | undefined {
  const needle = raw.trim().toLowerCase();
  if (!needle) return undefined;
  return Object.values(state.entities).find(
    (entity) =>
      entity.type === "person" &&
      entity.id !== config.player_id &&
      (entity.name.toLowerCase() === needle ||
        entity.id.toLowerCase() === needle ||
        entity.aliases.some((alias) => alias.toLowerCase() === needle)),
  );
}

function presentPeople(state: State, config: Config): Entity[] {
  const player = state.entities[config.player_id];
  const here = player?.location;
  if (!here) return [];
  return Object.values(state.entities)
    .filter(
      (entity) =>
        entity.type === "person" &&
        entity.id !== config.player_id &&
        entity.location === here &&
        !entity.tags.includes("unmet") &&
        !entity.tags.includes("dead"),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function addressee(state: State, config: Config, who: string): { label: string; ids: string[] } {
  if (who.toLowerCase() !== "you") {
    const person = personByName(state, config, who);
    return { label: person?.name ?? properName(who), ids: person ? [person.id] : [] };
  }
  const here = presentPeople(state, config).slice(0, 4);
  if (here.length === 0) return { label: "Someone", ids: [] };
  const names = here.map((entity) => entity.name);
  const label = names.length === 1 ? (names[0] ?? "Someone") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return { label, ids: here.map((entity) => entity.id) };
}

function readName(line: string): StatementHit | undefined {
  const match = /\bmy name(?:'s|’s|s| is)\s+([a-z][a-z'-]{1,24})\b/i.exec(line);
  const raw = match?.[1];
  if (!raw || noise(raw)) return undefined;
  const name = properName(raw);
  return { kind: "name", text: `Your name is ${name}.`, name };
}

function readAlias(line: string, state: State, config: Config): StatementHit | undefined {
  const match = /^it'?s\s+([a-z][a-z'-]{2,24})\b([\s\S]*)$/i.exec(line.trim());
  const raw = match?.[1];
  if (!raw || noise(raw)) return undefined;
  const rest = (match?.[2] ?? "").trim();
  if (rest !== "" && !/^[,.]/.test(rest)) return undefined;
  if (!rest.startsWith(",") && personByName(state, config, raw)) return undefined;
  const alias = properName(raw);
  return { kind: "alias", text: `You go by ${alias}.`, alias };
}

function readSaid(line: string, state: State, config: Config): StatementHit | undefined {
  const match =
    /\b([a-z][a-z'-]{2,24})\s+has\s+(?:already\s+)?said\s+(?:that\s+)?((?:he|she|they)'?s|hes|shes|theyre)\s+(.+)/i.exec(
      line,
    );
  const who = match?.[1];
  const actionRaw = match?.[3];
  if (!who || !actionRaw || noise(who)) return undefined;
  let action = (actionRaw.split(/[.\n]/)[0] ?? "").replace(/\s+i\s+.*/i, "").trim();
  action = action.replace(/^(?:is\s+)/i, "").replace(/[,;]\s*$/, "").trim();
  if (action.length < 3) return undefined;
  const named = addressee(state, config, who);
  const text = tidy(`${named.label} is ${action}`);
  return {
    kind: "commitment",
    text,
    thread: { kind: "commitment", text, entities: named.ids },
  };
}

function readDebt(line: string, state: State, config: Config): StatementHit | undefined {
  const match =
    /\b(you|[a-z][a-z'-]{2,24})\s+(?:do\s+|does\s+)?owes?\s+me\s+(?:a|an|the)\s+([a-z][a-z'-]{2,24})\b/i.exec(line);
  const who = match?.[1];
  const what = match?.[2]?.toLowerCase();
  if (!who || !what || noise(what) || /n'?t$/i.test(who) || /^(?:not|dont|don't)$/i.test(who)) return undefined;
  const named = addressee(state, config, who);
  const verb = named.ids.length === 1 ? "owes" : named.label === "Someone" ? "owes" : "owe";
  const text = tidy(`${named.label} ${verb} you a ${what}.`);
  return {
    kind: "commitment",
    text,
    thread: { kind: "debt", text, entities: named.ids },
  };
}

function readPlan(line: string): StatementHit | undefined {
  const re = new RegExp(`\\b([a-z][a-z'-]*(?:\\s+[a-z][a-z'-]*){0,4})\\s+at\\s+(${TIME})\\b`, "gi");
  for (let match = re.exec(line); match !== null; match = re.exec(line)) {
    const place = (match[1] ?? "").trim();
    const time = (match[2] ?? "").trim();
    const head = place.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!place || !time || PLACE_HEAD.has(head) || noise(head)) continue;
    const words = place.split(/\s+/);
    if (words.length < 2 && place.length < 4) continue;
    const text = tidy(`${place} at ${time}`);
    return { kind: "commitment", text, thread: { kind: "commitment", text, entities: [] } };
  }
  return undefined;
}

/** Commitments, a stated name, and a stated nickname. Weather and a price aside are not commitments. */
export function readPlayerStatements(input: string, state: State, config: Config): StatementHit[] {
  const text = input.trim();
  if (text === "" || /^ooc\b/i.test(text) || /^\(.*\)$/s.test(text)) return [];
  const hits: StatementHit[] = [];
  const seen = new Set<string>();
  const push = (hit: StatementHit | undefined): void => {
    if (!hit) return;
    const key = `${hit.kind}:${hit.text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };
  for (const line of linesOf(text)) {
    push(readName(line));
    push(readAlias(line, state, config));
    push(readSaid(line, state, config));
    push(readDebt(line, state, config));
    push(readPlan(line));
  }
  return hits;
}

function remember(state: State, hit: StatementHit): void {
  if (!state.ledger) state.ledger = [];
  const key = hit.text.toLowerCase();
  if (state.ledger.some((entry) => entry.text.toLowerCase() === key)) return;
  state.ledger.push({ turn: state.turn, text: hit.text, kind: hit.kind });
  const identity = state.ledger.filter((entry) => entry.kind !== "commitment");
  const commitments = state.ledger.filter((entry) => entry.kind === "commitment").slice(-LEDGER_CAP);
  const keep = new Set<State["ledger"][number]>([...identity, ...commitments]);
  state.ledger = state.ledger.filter((entry) => keep.has(entry));
}

function openCommitment(state: State, hit: StatementHit): void {
  const thread = hit.thread;
  if (!thread) return;
  if (duplicateOpenThread(state.threads, thread.text, undefined, state.clock.now)) return;
  const turn = state.turn;
  state.threads.push({
    id: `t${state.threads.length + 1}`,
    kind: thread.kind,
    text: thread.text,
    status: "open",
    entities: thread.entities.filter((id) => state.entities[id]),
    scale: "minor",
    was_major: false,
    warm: true,
    reminders: 0,
    last_shown_turn: turn,
    last_interacted_turn: turn,
    last_interacted_at: state.clock.now,
    opened_turn: turn,
  });
}

/**
 * Writes what the player just stated onto the save. The model does not have to emit it.
 * A nickname and a name land on the player. A debt, a reported promise, and a place-and-time
 * land on the ledger and as a minor thread.
 */
export function recordPlayerStatements(state: State, config: Config, input: string): void {
  const player = state.entities[config.player_id];
  if (!player) return;
  for (const hit of readPlayerStatements(input, state, config)) {
    if (hit.name && player.name.toLowerCase() !== hit.name.toLowerCase()) {
      player.name = hit.name;
      player.last_touched = state.turn;
    }
    if (
      hit.alias &&
      player.name.toLowerCase() !== hit.alias.toLowerCase() &&
      !player.aliases.some((alias) => alias.toLowerCase() === hit.alias?.toLowerCase())
    ) {
      player.aliases.push(hit.alias);
      player.last_touched = state.turn;
    }
    remember(state, hit);
    openCommitment(state, hit);
  }
}
