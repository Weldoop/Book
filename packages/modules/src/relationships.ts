import type { Config, Module, Op, State, Violation } from "@book/schema";

export interface RelationshipsState {
  values: Record<string, number>;
}

export const REL_MIN = -100;
export const REL_MAX = 100;

export function relKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function relationshipsOf(state: State): RelationshipsState {
  return (state.modules.relationships as RelationshipsState | undefined) ?? { values: {} };
}

export function relationshipValue(state: State, a: string, b: string): number {
  return relationshipsOf(state).values[relKey(a, b)] ?? 0;
}

export const relationshipsModule: Module = {
  id: "relationships",
  ops: ["relationship.add"],

  initState(config) {
    const values: Record<string, number> = {};
    for (const row of config.seed.relationships) values[relKey(row.a, row.b)] = row.value;
    return { values } satisfies RelationshipsState;
  },

  validateOp(op: Op, index: number, state: State): Violation[] {
    if (op.op !== "relationship.add") return [];
    const out: Violation[] = [];
    for (const id of [op.a, op.b]) {
      if (!state.entities[id]) {
        out.push({
          severity: "fixable",
          code: "unknown_entity",
          op_index: index,
          message: `Op ${index}: relationship references unknown entity '${id}'.`,
        });
      }
    }
    if (op.a === op.b) {
      out.push({ severity: "fixable", code: "self_relationship", op_index: index, message: `Op ${index}: a relationship needs two different entities.` });
    }
    if (Math.abs(op.amount) > 25) {
      out.push({
        severity: "fixable",
        code: "relationship_step_too_large",
        op_index: index,
        message: `Op ${index}: a single relationship change is limited to +/-25 (got ${op.amount}). Use a smaller step.`,
      });
    }
    return out;
  },

  applyOp(op: Op, state: State): State {
    if (op.op !== "relationship.add") return state;
    const s = structuredClone(state);
    const rel = (s.modules.relationships as RelationshipsState | undefined) ?? { values: {} };
    const key = relKey(op.a, op.b);
    rel.values[key] = Math.max(REL_MIN, Math.min(REL_MAX, (rel.values[key] ?? 0) + op.amount));
    s.modules.relationships = rel;
    return s;
  },

  promptFragment: () =>
    "RELATIONSHIPS: Standing between two people runs from -100 to 100. Shift it in small steps (usually 1 to 10) with relationship.add when an interaction clearly changes how they feel. Do not mention the numbers.",

  focus: () => [],
  due: () => [],

  snapshot: relationshipSnapshot,

  render(state, config) {
    return { panel: relationshipSnapshot(state, config) };
  },
};

function relationshipSnapshot(state: State, config: Config): string[] {
  {
    const player = config.player_id;
    const rows = Object.entries(relationshipsOf(state).values)
      .map(([key, value]) => ({ key, value, others: key.split("|") }))
      .filter((r) => r.others.includes(player) && r.value !== 0)
      .sort((x, y) => Math.abs(y.value) - Math.abs(x.value))
      .slice(0, 8)
      .map((r) => {
        const other = r.others.find((id) => id !== player) ?? "";
        const name = state.entities[other]?.name ?? other;
        return `${name} ${r.value > 0 ? "+" : ""}${r.value}`;
      });
    return rows.length ? [`Relationships: ${rows.join(", ")}`] : [];
  }
}
