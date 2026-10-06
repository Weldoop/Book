import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore, MemoryStore } from "../src/index.ts";
import { storeContract } from "./contract.ts";
import { makeRecord, makeState } from "./fixtures.ts";

storeContract("MemoryStore", async () => new MemoryStore());
storeContract("FileStore", async () => new FileStore(await mkdtemp(join(tmpdir(), "book-store-"))));

describe("FileStore specifics", () => {
  it("lays out state.json, turns.jsonl and log.jsonl per save, leaving no temp files", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-store-"));
    const s = new FileStore(root);
    await s.createSave(makeState("a"));
    await s.commitTurn({ save_id: "a", expected_turn: 0, state: makeState("a", 1), record: makeRecord(1) });
    await s.appendLog("a", { x: 1 });
    expect((await readdir(join(root, "a"))).sort()).toEqual(["log.jsonl", "state.json", "turns.jsonl"]);
    const lines = (await readFile(join(root, "a", "turns.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).turn).toBe(1);
  });

  it("persists across instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-store-"));
    await new FileStore(root).createSave(makeState("a"));
    expect((await new FileStore(root).loadSave("a")).save_id).toBe("a");
  });

  it("reports corrupt state clearly", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-store-"));
    const s = new FileStore(root);
    await s.createSave(makeState("a"));
    await writeFile(join(root, "a", "state.json"), "{not json");
    await expect(s.loadSave("a")).rejects.toThrow(/not valid JSON/);
    await writeFile(join(root, "a", "state.json"), JSON.stringify({ version: 1 }));
    await expect(s.loadSave("a")).rejects.toThrow(/Corrupt save state/);
  });

  it("reports a corrupt turns.jsonl line", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-store-"));
    const s = new FileStore(root);
    await s.createSave(makeState("a"));
    await writeFile(join(root, "a", "turns.jsonl"), "{bad}\n");
    await expect(s.readTurnRecords("a")).rejects.toThrow(/line 1/);
  });

  it("listSaves skips corrupt and non-save directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "book-store-"));
    const s = new FileStore(root);
    await s.createSave(makeState("good"));
    await s.createSave(makeState("bad"));
    await writeFile(join(root, "bad", "state.json"), "oops");
    expect((await s.listSaves()).map((m) => m.save_id)).toEqual(["good"]);
  });

  it("lists nothing when the root directory is absent", async () => {
    const s = new FileStore(join(await mkdtemp(join(tmpdir(), "book-store-")), "missing"));
    expect(await s.listSaves()).toEqual([]);
  });
});
