import type { SaveMeta, State, Store, TurnCommit, TurnRecord } from "@book/schema";
import { assertSafeSaveId } from "./ids.ts";
import { checkCommit, checkUpdate, parseState } from "./rules.ts";

interface Save {
  state: State;
  turns: TurnRecord[];
  log: unknown[];
}

export class MemoryStore implements Store {
  private readonly saves = new Map<string, Save>();

  private get(saveId: string): Save {
    assertSafeSaveId(saveId);
    const s = this.saves.get(saveId);
    if (!s) throw new Error(`Save "${saveId}" not found`);
    return s;
  }

  async createSave(state: State): Promise<void> {
    assertSafeSaveId(state.save_id);
    if (this.saves.has(state.save_id)) throw new Error(`Save "${state.save_id}" already exists`);
    const valid = parseState(structuredClone(state), "create");
    this.saves.set(state.save_id, { state: valid, turns: [], log: [] });
  }

  async loadSave(saveId: string): Promise<State> {
    return structuredClone(this.get(saveId).state);
  }

  async commitTurn(commit: TurnCommit): Promise<void> {
    const s = this.get(commit.save_id);
    checkCommit(commit, s.state.turn);
    s.turns.push(structuredClone(commit.record));
    s.state = structuredClone(commit.state);
  }

  async appendLog(saveId: string, entry: unknown): Promise<void> {
    this.get(saveId).log.push(structuredClone(entry));
  }

  async updateState(saveId: string, state: State, expectedTurn: number): Promise<void> {
    const s = this.get(saveId);
    checkUpdate(saveId, state, expectedTurn, s.state.turn);
    s.state = structuredClone(state);
  }

  async listSaves(): Promise<SaveMeta[]> {
    return [...this.saves.values()]
      .map(({ state }) => ({
        save_id: state.save_id,
        config_id: state.config_id,
        config_version: state.config_version,
        turn: state.turn,
      }))
      .sort((a, b) => a.save_id.localeCompare(b.save_id));
  }

  async readTurnRecords(saveId: string): Promise<TurnRecord[]> {
    return structuredClone(this.get(saveId).turns);
  }

  async readLog(saveId: string): Promise<unknown[]> {
    return structuredClone(this.get(saveId).log);
  }
}
