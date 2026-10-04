import { OP_NAMES, OpSchema } from "@book/schema";
import { describe, expect, it } from "vitest";
import { describeOps } from "../src/index.ts";
import { OP_FIELDS } from "../src/ops.ts";
import { inventoryModule, makeModule, statsModule } from "./fixtures.ts";

describe("describeOps", () => {
  it("renders core ops plus only the active module ops", () => {
    const text = describeOps([statsModule]);
    for (const n of ["clock.advance", "entity.create", "entity.move", "entity.fact.add", "thread.open", "thread.resolve", "stat.add", "stat.set"]) {
      expect(text).toContain(`- ${n}{`);
    }
    expect(text).not.toContain("inventory.add");
    expect(text).not.toContain("relationship.add");
  });

  it("is stable regardless of module order and dedupes core ops", () => {
    const core = makeModule({ id: "core", ops: ["clock.advance", "entity.create"] });
    const a = describeOps([inventoryModule, statsModule, core]);
    const b = describeOps([core, statsModule, inventoryModule]);
    expect(a).toBe(b);
    expect(a.match(/clock\.advance\{/g)).toHaveLength(1);
  });

  it("falls back for ops without a signature", () => {
    const odd = makeModule({ id: "odd", ops: ["weird.op" as never] });
    expect(describeOps([odd])).toContain("- weird.op{...}");
  });

  it("signature table matches the Zod op schema field names exactly", () => {
    expect(Object.keys(OP_FIELDS).sort()).toEqual([...OP_NAMES].sort());
    for (const option of OpSchema.options) {
      const name = option.shape.op.value;
      const schemaKeys = Object.keys(option.shape).filter((k) => k !== "op").sort();
      const tableKeys = OP_FIELDS[name].map(([k]) => k).sort();
      expect(tableKeys, name).toEqual(schemaKeys);
      const optionalInSchema = Object.entries(option.shape)
        .filter(([k, v]) => k !== "op" && v.isOptional())
        .map(([k]) => k)
        .sort();
      const optionalInTable = OP_FIELDS[name].filter(([, , o]) => o).map(([k]) => k).sort();
      expect(optionalInTable, name).toEqual(optionalInSchema);
    }
  });
});
