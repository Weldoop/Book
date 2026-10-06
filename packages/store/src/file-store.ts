import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SaveMeta, State, Store, TurnCommit, TurnRecord } from "@book/schema";
import { assertSafeSaveId } from "./ids.ts";
import { checkCommit, checkUpdate, parseState } from "./rules.ts";

export const DEFAULT_STORE_ROOT = ".book-data";

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * One directory per save: state.json (atomic replace), turns.jsonl and log.jsonl (append-only).
 * A turn record is appended before state.json is replaced, so a crash in between leaves an extra record, never a lost one.
 */
export class FileStore implements Store {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string = join(process.cwd(), DEFAULT_STORE_ROOT)) {
    this.root = resolve(root);
  }

  private dir(saveId: string): string {
    assertSafeSaveId(saveId);
    return join(this.root, saveId);
  }

  private serial<T>(saveId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(saveId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      saveId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async readState(saveId: string): Promise<State> {
    const path = join(this.dir(saveId), "state.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (isNotFound(err)) throw new Error(`Save "${saveId}" not found in ${this.root}`);
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupt save "${saveId}": state.json is not valid JSON`);
    }
    return parseState(json, saveId);
  }

  async createSave(state: State): Promise<void> {
    const dir = this.dir(state.save_id);
    parseState(state, "create");
    await mkdir(this.root, { recursive: true });
    try {
      await mkdir(dir);
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") {
        const exists = await readFile(join(dir, "state.json"), "utf8").then(
          () => true,
          () => false,
        );
        if (exists) throw new Error(`Save "${state.save_id}" already exists`);
      } else throw err;
    }
    await atomicWrite(join(dir, "state.json"), JSON.stringify(state, null, 2));
    await writeFile(join(dir, "turns.jsonl"), "", { flag: "a" });
    await writeFile(join(dir, "log.jsonl"), "", { flag: "a" });
  }

  loadSave(saveId: string): Promise<State> {
    return this.serial(saveId, () => this.readState(saveId));
  }

  commitTurn(commit: TurnCommit): Promise<void> {
    return this.serial(commit.save_id, async () => {
      const stored = await this.readState(commit.save_id);
      checkCommit(commit, stored.turn);
      const dir = this.dir(commit.save_id);
      await appendFile(join(dir, "turns.jsonl"), `${JSON.stringify(commit.record)}\n`, "utf8");
      await atomicWrite(join(dir, "state.json"), JSON.stringify(commit.state, null, 2));
    });
  }

  appendLog(saveId: string, entry: unknown): Promise<void> {
    return this.serial(saveId, async () => {
      await this.readState(saveId);
      await appendFile(join(this.dir(saveId), "log.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    });
  }

  updateState(saveId: string, state: State, expectedTurn: number): Promise<void> {
    return this.serial(saveId, async () => {
      const stored = await this.readState(saveId);
      checkUpdate(saveId, state, expectedTurn, stored.turn);
      await atomicWrite(join(this.dir(saveId), "state.json"), JSON.stringify(state, null, 2));
    });
  }

  async listSaves(): Promise<SaveMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const metas: SaveMeta[] = [];
    for (const name of names.sort()) {
      try {
        const s = await this.readState(name);
        metas.push({ save_id: s.save_id, config_id: s.config_id, config_version: s.config_version, turn: s.turn });
      } catch {
        // not a save directory, or a corrupt one: loadSave reports those precisely
      }
    }
    return metas;
  }

  readTurnRecords(saveId: string): Promise<TurnRecord[]> {
    return this.serial(saveId, async () => {
      await this.readState(saveId);
      return this.readJsonl<TurnRecord>(saveId, "turns.jsonl");
    });
  }

  readLog(saveId: string): Promise<unknown[]> {
    return this.serial(saveId, async () => {
      await this.readState(saveId);
      return this.readJsonl<unknown>(saveId, "log.jsonl");
    });
  }

  private async readJsonl<T>(saveId: string, file: string): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir(saveId), file), "utf8");
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const out: T[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        throw new Error(`Corrupt ${file} for save "${saveId}" at line ${i + 1}`);
      }
    }
    return out;
  }
}
