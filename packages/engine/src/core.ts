import type { Config, DueItem, Entity, Fact, Module, Op, RenderOutput, State, Violation } from "@book/schema";
import { memoryExpiry } from "./memory.ts";
import { duplicateOpenThread } from "./threads.ts";
import { addMinutes, diffMinutes } from "./time.ts";

const MAX_FACT_CHARS = 220;
const MAX_FACTS_PER_ENTITY = 12;

/** A person the player has not met. Cleared when they share the player's location. */
export const UNMET = "unmet";
/** A place that has been mentioned and not yet entered. */
export const UNVISITED = "unvisited";

function withoutTag(tags: string[], tag: string): string[] {
  return tags.filter((t) => t !== tag);
}

function bad(code: string, message: string, index: number, severity: Violation["severity"] = "fixable"): Violation {
  return { severity, code, message, op_index: index };
}

function clone(state: State): State {
  return structuredClone(state);
}

function touch(entity: Entity, turn: number): void {
  entity.last_touched = turn;
}

function openMajorCount(state: State): number {
  return state.threads.filter((t) => t.status === "open" && t.scale === "major").length;
}

/** The open major the player has left alone the longest. Older opening, then id, breaks a tie. */
function quietestMajor(state: State): State["threads"][number] | undefined {
  const majors = state.threads.filter((t) => t.status === "open" && t.scale === "major");
  majors.sort(
    (a, b) =>
      a.last_interacted_turn - b.last_interacted_turn || a.opened_turn - b.opened_turn || a.id.localeCompare(b.id),
  );
  return majors[0];
}

/** A long matter steps back. It stays open, keeps its deadline, and can be offered again. */
function demoteMajor(thread: State["threads"][number]): void {
  thread.scale = "minor";
  thread.was_major = true;
  thread.warm = true;
  thread.reminders = 0;
}

/** Keeps at most `max_majors` in the lead by setting the quietest one aside. */
function makeRoomForMajor(state: State, config: Config): void {
  while (openMajorCount(state) >= config.threads.max_majors) {
    const quiet = quietestMajor(state);
    if (!quiet) break;
    demoteMajor(quiet);
  }
}

export const coreModule: Module = {
  id: "core",
  ops: [
    "clock.advance",
    "clock.skip",
    "entity.create",
    "entity.move",
    "entity.fact.add",
    "thread.open",
    "thread.adopt",
    "thread.resolve",
  ],
  initState: () => ({}),

  validateOp(op, index, state, config) {
    const out: Violation[] = [];
    switch (op.op) {
      case "clock.advance":
        if (op.minutes > config.time.max_per_turn) {
          const cap = config.time.max_skip_minutes;
          const asSkip = cap > 0 && op.minutes <= cap;
          out.push(
            bad(
              "time_jump",
              asSkip
                ? `Op ${index}: clock.advance of ${op.minutes} minutes is longer than one scene (${config.time.max_per_turn}). Use clock.skip with a reason instead, at most ${cap} minutes, and keep the move.`
                : `Op ${index}: clock.advance of ${op.minutes} minutes exceeds the per-turn limit of ${config.time.max_per_turn}.`,
              index,
              asSkip ? "fixable" : "game_breaking",
            ),
          );
        }
        break;
      case "clock.skip": {
        const cap = config.time.max_skip_minutes;
        if (cap === 0) {
          out.push(
            bad(
              "skip_forbidden",
              `Op ${index}: this game does not allow skipping time${config.time.rest_note ? ` (${config.time.rest_note})` : ""}. Play the hours through instead.`,
              index,
              "game_breaking",
            ),
          );
        } else if (op.minutes > cap) {
          out.push(
            bad(
              "skip_too_long",
              `Op ${index}: clock.skip of ${op.minutes} minutes exceeds the limit of ${cap} for one skip. Skip at most ${cap} minutes and let the player carry on.`,
              index,
              "game_breaking",
            ),
          );
        }
        break;
      }
      case "entity.create":
        if (state.entities[op.id]) {
          out.push(bad("entity_exists", `Op ${index}: entity '${op.id}' already exists; use entity.fact.add to add facts.`, index));
        }
        if (op.location && !state.entities[op.location]) {
          out.push(bad("unknown_entity", `Op ${index}: location '${op.location}' does not exist; create it first.`, index));
        }
        break;
      case "entity.move": {
        const target = state.entities[op.id];
        if (!target) out.push(bad("unknown_entity", `Op ${index}: entity '${op.id}' does not exist.`, index));
        else if (target.tags.includes("dead")) {
          out.push(bad("dead_entity", `Op ${index}: '${target.name}' is dead and cannot move.`, index, "game_breaking"));
        }
        const dest = state.entities[op.location];
        if (!dest) out.push(bad("unknown_entity", `Op ${index}: destination '${op.location}' does not exist; create it first.`, index));
        else if (dest.type !== "place") out.push(bad("not_a_place", `Op ${index}: destination '${op.location}' is not a place.`, index));
        break;
      }
      case "entity.fact.add":
        if (!state.entities[op.id]) out.push(bad("unknown_entity", `Op ${index}: entity '${op.id}' does not exist.`, index));
        if (op.fact.length > MAX_FACT_CHARS) {
          out.push(bad("fact_too_long", `Op ${index}: fact is longer than ${MAX_FACT_CHARS} characters; keep facts short.`, index));
        }
        break;
      case "thread.open":
        for (const id of op.entities ?? []) {
          if (!state.entities[id]) out.push(bad("unknown_entity", `Op ${index}: thread references unknown entity '${id}'.`, index));
        }
        if (op.due && diffMinutes(op.due, state.clock.now) < 0) {
          out.push(bad("due_in_past", `Op ${index}: thread due time ${op.due} is already in the past.`, index));
        }
        {
          const dup = duplicateOpenThread(state.threads, op.text, op.due);
          if (dup) {
            out.push(
              bad(
                "duplicate_thread",
                `Op ${index}: this repeats open thread '${dup.id}'. Do not open a second thread for the same matter.`,
                index,
              ),
            );
          }
        }
        if (op.parent && !state.threads.some((t) => t.id === op.parent)) {
          out.push(bad("unknown_thread", `Op ${index}: parent thread '${op.parent}' does not exist.`, index));
        }
        break;
      case "thread.adopt": {
        const thread = state.threads.find((t) => t.id === op.id);
        if (!thread) out.push(bad("unknown_thread", `Op ${index}: thread '${op.id}' does not exist.`, index));
        else if (thread.status !== "open") {
          out.push(bad("thread_closed", `Op ${index}: thread '${op.id}' is ${thread.status} and cannot be taken up.`, index));
        }
        break;
      }
      case "thread.resolve": {
        const thread = state.threads.find((t) => t.id === op.id);
        if (!thread) out.push(bad("unknown_thread", `Op ${index}: thread '${op.id}' does not exist.`, index));
        else if (thread.status === "resolved") out.push(bad("thread_resolved", `Op ${index}: thread '${op.id}' is already resolved.`, index));
        break;
      }
      default:
        break;
    }
    return out;
  },

  applyOp(op: Op, state: State, config: Config): State {
    const s = clone(state);
    const turn = s.turn + 1;
    switch (op.op) {
      case "clock.advance":
        s.clock.now = addMinutes(s.clock.now, op.minutes);
        break;
      case "clock.skip":
        s.clock.now = addMinutes(s.clock.now, op.minutes);
        break;
      case "entity.create":
        s.entities[op.id] = {
          id: op.id,
          type: op.type,
          name: op.name,
          aliases: op.aliases ?? [],
          location: op.location ?? null,
          facts: (op.facts ?? []).map((text) => ({ text, importance: 2 as const, turn })),
          tags: op.tags ?? [],
          last_touched: turn,
        };
        break;
      case "entity.move": {
        const e = s.entities[op.id];
        if (e) {
          e.location = op.location;
          touch(e, turn);
        }
        break;
      }
      case "entity.fact.add": {
        const e = s.entities[op.id];
        if (e) {
          const fact: Fact = { text: op.fact, importance: op.importance, turn };
          if (e.type === "person" && op.importance < 3) {
            const expires = memoryExpiry(s.clock.now, op.importance);
            if (expires) fact.expires = expires;
          }
          e.facts.push(fact);
          if (e.facts.length > MAX_FACTS_PER_ENTITY) {
            e.facts.sort((a, b) => b.importance - a.importance || b.turn - a.turn);
            e.facts = e.facts.slice(0, MAX_FACTS_PER_ENTITY);
          }
          touch(e, turn);
        }
        break;
      }
      case "thread.open": {
        if (op.scale === "major") makeRoomForMajor(s, config);
        const id = `t${s.threads.length + 1}`;
        s.threads.push({
          id,
          kind: op.kind,
          text: op.text,
          ...(op.due ? { due: op.due } : {}),
          status: "open",
          entities: op.entities ?? [],
          scale: op.scale,
          was_major: false,
          ...(op.scale === "potential" ? { expires: addMinutes(s.clock.now, config.threads.potential_hours * 60) } : {}),
          warm: true,
          reminders: 0,
          last_shown_turn: turn,
          last_interacted_turn: turn,
          ...(op.parent ? { parent: op.parent } : {}),
          opened_turn: turn,
        });
        for (const ref of op.entities ?? []) {
          const e = s.entities[ref];
          if (e) touch(e, turn);
        }
        break;
      }
      case "thread.adopt": {
        const t = s.threads.find((x) => x.id === op.id);
        if (t && t.status === "open") {
          if (op.scale === "major" && t.scale !== "major") makeRoomForMajor(s, config);
          if (t.scale === "major" && op.scale === "minor") demoteMajor(t);
          t.scale = op.scale;
          t.warm = true;
          t.reminders = 0;
          t.last_interacted_turn = turn;
          delete t.expires;
        }
        break;
      }
      case "thread.resolve": {
        const t = s.threads.find((x) => x.id === op.id);
        if (t) {
          t.status = "resolved";
          t.resolved_turn = turn;
        }
        break;
      }
      default:
        break;
    }
    return s;
  },

  promptFragment: () => "",
  focus: () => [],
  due: (): DueItem[] => [],
  snapshot: () => [],
  render: (): RenderOutput => ({}),
};

export function playerLocation(state: State, config: Config): string | null {
  return state.entities[config.player_id]?.location ?? null;
}

/**
 * Arriving clears `unvisited` on that place. Sharing the player's location clears `unmet`.
 * The status line and the cast the player has met are then the same facts.
 */
export function syncPresence(state: State, config: Config): State {
  const here = playerLocation(state, config);
  if (!here) return state;
  const next = clone(state);
  const place = next.entities[here];
  if (place?.tags.includes(UNVISITED)) place.tags = withoutTag(place.tags, UNVISITED);
  for (const entity of Object.values(next.entities)) {
    if (entity.type !== "person" || entity.id === config.player_id) continue;
    if (entity.location === here && entity.tags.includes(UNMET)) entity.tags = withoutTag(entity.tags, UNMET);
  }
  return next;
}
