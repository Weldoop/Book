import { describe, expect, it } from "vitest";
import type { Store } from "@book/schema";
import { makeRecord, makeState } from "./fixtures.ts";

export type TestStore = Store & { readLog(saveId: string): Promise<unknown[]> };

export function storeContract(name: string, make: () => Promise<TestStore>): void {
  describe(`${name} store contract`, () => {
    it("creates, loads and lists saves", async () => {
      const s = await make();
      expect(await s.listSaves()).toEqual([]);
      await s.createSave(makeState("b"));
      await s.createSave(makeState("a"));
      expect(await s.loadSave("a")).toEqual(makeState("a"));
      expect(await s.listSaves()).toEqual([
        { save_id: "a", config_id: "uk-life", config_version: 1, turn: 0 },
        { save_id: "b", config_id: "uk-life", config_version: 1, turn: 0 },
      ]);
    });

    it("refuses to overwrite an existing save", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      await expect(s.createSave(makeState("a"))).rejects.toThrow(/already exists/);
    });

    it("throws a clear error for a missing save", async () => {
      const s = await make();
      await expect(s.loadSave("nope")).rejects.toThrow(/not found/);
      await expect(s.readTurnRecords("nope")).rejects.toThrow(/not found/);
    });

    it("commits turns, advancing state and appending records", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      for (let t = 1; t <= 3; t++) {
        await s.commitTurn({ save_id: "a", expected_turn: t - 1, state: makeState("a", t), record: makeRecord(t) });
      }
      expect((await s.loadSave("a")).turn).toBe(3);
      expect((await s.readTurnRecords("a")).map((r) => r.turn)).toEqual([1, 2, 3]);
      expect((await s.listSaves())[0]?.turn).toBe(3);
    });

    it("rejects a stale expected_turn without writing", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      await s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 1), record: makeRecord(1) });
      await expect(
        s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 1), record: makeRecord(1) }),
      ).rejects.toThrow(/conflict/);
      expect(await s.readTurnRecords("a")).toHaveLength(1);
    });

    it("rejects a committed state that does not advance by exactly one", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      await expect(
        s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 2), record: makeRecord(1) }),
      ).rejects.toThrow(/requires 1/);
      await expect(
        s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 0), record: makeRecord(1) }),
      ).rejects.toThrow(/requires 1/);
      expect((await s.loadSave("a")).turn).toBe(0);
      expect(await s.readTurnRecords("a")).toEqual([]);
    });

    it("rejects a mismatched save_id in the committed state", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      await s.createSave(makeState("b"));
      await expect(
        s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("b", 1), record: makeRecord(1) }),
      ).rejects.toThrow(/save_id/);
    });

    it("records rolled-back turns without advancing the turn", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      await s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 1), record: makeRecord(1) });
      const kept = makeState("a", 1);
      kept.beats = [{ turn: 1, text: "kept" }];
      await s.commitTurn({ save_id: "a", expected_turn: 1, state: kept, record: makeRecord(2, "rolled_back") });
      expect((await s.loadSave("a")).turn).toBe(1);
      const recs = await s.readTurnRecords("a");
      expect(recs.map((r) => r.outcome)).toEqual(["ok", "rolled_back"]);
      await s.commitTurn({ save_id: "a", expected_turn: 1, state: makeState("a", 2), record: makeRecord(2) });
      expect((await s.loadSave("a")).turn).toBe(2);
    });

    it("rejects a rolled-back commit that advances the turn", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      await expect(
        s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 1), record: makeRecord(1, "rolled_back") }),
      ).rejects.toThrow(/requires 0/);
    });

    it("updateState replaces state at the same turn and checks concurrency", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      await s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 1), record: makeRecord(1) });
      const compacted = makeState("a", 1);
      compacted.summaries.story_so_far = "compacted";
      await s.updateState("a", compacted, 1);
      expect((await s.loadSave("a")).summaries.story_so_far).toBe("compacted");
      await expect(s.updateState("a", compacted, 0)).rejects.toThrow(/conflict/);
      await expect(s.updateState("a", makeState("a", 2), 1)).rejects.toThrow(/must equal/);
      expect(await s.readTurnRecords("a")).toHaveLength(1);
    });

    it("appends log entries without touching state or turns", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      await s.appendLog("a", { kind: "compaction", n: 1 });
      await s.appendLog("a", { kind: "rollback", n: 2 });
      expect(await s.readLog("a")).toEqual([
        { kind: "compaction", n: 1 },
        { kind: "rollback", n: 2 },
      ]);
      expect(await s.readTurnRecords("a")).toEqual([]);
      await expect(s.appendLog("zzz", {})).rejects.toThrow(/not found/);
    });

    it("validates save ids as safe path segments", async () => {
      const s = await make();
      for (const bad of ["../evil", "a/b", "", ".hidden", "a..b", "x".repeat(65), "a b"]) {
        await expect(s.loadSave(bad)).rejects.toThrow(/Invalid save id/);
        await expect(s.createSave(makeState(bad))).rejects.toThrow(/Invalid save id/);
      }
    });

    it("rejects invalid state on create and commit", async () => {
      const s = await make();
      await expect(s.createSave({ ...makeState("a"), turn: -1 })).rejects.toThrow(/Corrupt save state/);
      await s.createSave(makeState("a"));
      await expect(
        s.commitTurn({
          save_id: "a",
          expected_turn: 0,
          state: { ...makeState("a", 1), clock: { now: "yesterday" } },
          record: makeRecord(1),
        }),
      ).rejects.toThrow(/Corrupt save state/);
    });

    it("serialises concurrent commits so only one wins", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      const results = await Promise.allSettled(
        [1, 2, 3].map(() =>
          s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 1), record: makeRecord(1) }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await s.readTurnRecords("a")).toHaveLength(1);
    });

    it("returns copies, not references", async () => {
      const s = await make();
      await s.createSave(makeState("a"));
      const loaded = await s.loadSave("a");
      loaded.beats.push({ turn: 9, text: "mutated" });
      expect((await s.loadSave("a")).beats).toEqual([]);
    });
  });
}
