import type { Config, DueItem, Entity, Module, Op, RenderOutput, State, Violation } from "@book/schema";
import { addMinutes, diffMinutes } from "./time.ts";

const MAX_FACT_CHARS = 220;
const MAX_FACTS_PER_ENTITY = 12;

function bad(code: string, message: string, index: number, severity: Violation["severity"] = "fixable"): Violation {
  return { severity, code, message, op_index: index };
}

function clone(state: State): State {
  return structuredClone(state);
}

function touch(entity: Entity, turn: number): void {
  entity.last_touched = turn;
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
    "thread.resolve",
  ],
  initState: () => ({}),

  validateOp(op, index, state, config) {
    const out: Violation[] = [];
    switch (op.op) {
      case "clock.advance":
        if (op.minutes > config.time.max_per_turn) {
          out.push(
            bad(
              "time_jump",
              `Op ${index}: clock.advance of ${op.minutes} minutes exceeds the per-turn limit of ${config.time.max_per_turn}.`,
              index,
              "game_breaking",
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
        break;
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

  applyOp(op: Op, state: State): State {
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
          tags: [],
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
          e.facts.push({ text: op.fact, importance: op.importance, turn });
          if (e.facts.length > MAX_FACTS_PER_ENTITY) {
            e.facts.sort((a, b) => b.importance - a.importance || b.turn - a.turn);
            e.facts = e.facts.slice(0, MAX_FACTS_PER_ENTITY);
          }
          touch(e, turn);
        }
        break;
      }
      case "thread.open": {
        const id = `t${s.threads.length + 1}`;
        s.threads.push({
          id,
          kind: op.kind,
          text: op.text,
          ...(op.due ? { due: op.due } : {}),
          status: "open",
          entities: op.entities ?? [],
          warm: true,
          reminders: 0,
          last_shown_turn: turn,
          ...(op.parent ? { parent: op.parent } : {}),
          opened_turn: turn,
        });
        for (const ref of op.entities ?? []) {
          const e = s.entities[ref];
          if (e) touch(e, turn);
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
