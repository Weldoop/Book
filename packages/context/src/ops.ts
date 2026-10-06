import type { Module, OpName } from "@book/schema";

type Field = readonly [name: string, type: string, optional?: boolean];

const KIND = "commitment|goal|debt|mystery|callback";
const SCALE = "potential|minor|major";
const ETYPE = "person|place|item|faction|other";
const WHEN = "YYYY-MM-DDTHH:mm";

/** Hand-written signatures. Field names must match OpSchema in packages/schema/src/delta.ts. */
export const OP_FIELDS: Record<OpName, readonly Field[]> = {
  "clock.advance": [["minutes", "int>=0"]],
  "clock.set": [["now", WHEN]],
  "clock.skip": [
    ["minutes", "int>=1"],
    ["reason", "str"],
  ],
  "entity.create": [
    ["id", "id"],
    ["type", ETYPE],
    ["name", "str"],
    ["aliases", "[str]", true],
    ["location", "id", true],
    ["facts", "[str]", true],
    ["tags", "[str]", true],
  ],
  "entity.move": [
    ["id", "id"],
    ["location", "id"],
  ],
  "entity.fact.add": [
    ["id", "id"],
    ["fact", "str"],
    ["importance", "1|2|3", true],
  ],
  "thread.open": [
    ["kind", KIND],
    ["text", "str"],
    ["due", WHEN, true],
    ["entities", "[id]", true],
    ["parent", "thread id", true],
    ["scale", SCALE, true],
  ],
  "thread.adopt": [
    ["id", "thread id"],
    ["scale", "minor|major"],
  ],
  "thread.resolve": [["id", "thread id"]],
  "stat.add": [
    ["key", "stat"],
    ["amount", "num"],
    ["reason", "str", true],
  ],
  "stat.set": [
    ["key", "stat"],
    ["value", "num"],
    ["reason", "str", true],
  ],
  "item.create": [
    ["id", "id"],
    ["name", "str"],
    ["price", "num", true],
    ["keeps", "bool", true],
  ],
  "inventory.add": [
    ["owner", "id"],
    ["item", "item"],
    ["qty", "int>=1", true],
  ],
  "inventory.remove": [
    ["owner", "id"],
    ["item", "item"],
    ["qty", "int>=1", true],
  ],
  "relationship.add": [
    ["a", "id"],
    ["b", "id"],
    ["amount", "num"],
  ],
};

export const CORE_OPS: OpName[] = [
  "clock.advance",
  "clock.set",
  "entity.create",
  "entity.move",
  "entity.fact.add",
  "thread.open",
  "thread.adopt",
  "thread.resolve",
];

function signature(name: string): string {
  const fields = (OP_FIELDS as Record<string, readonly Field[] | undefined>)[name];
  if (!fields) return `${name}{...}`;
  return `${name}{${fields.map(([n, t, opt]) => `${n}${opt ? "?" : ""}:${t}`).join(",")}}`;
}

/** Ops available this game: core first, then ops of the active modules (sorted by module id). */
export function activeOpNames(modules: Module[]): string[] {
  const seen = new Set<string>(CORE_OPS);
  const names: string[] = [...CORE_OPS];
  for (const m of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const op of m.ops) {
      if (seen.has(op)) continue;
      seen.add(op);
      names.push(op);
    }
  }
  return names;
}

/** Compact op signatures for the model. Stable for a given module set. */
export function describeOps(modules: Module[]): string {
  const lines = activeOpNames(modules).map((n) => `- ${signature(n)}`);
  return [
    '{"op":"<name>", ...fields}. "?" is optional. id matches [a-z0-9_.-].',
    ...lines,
  ].join("\n");
}
