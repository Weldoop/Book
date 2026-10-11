import type { SaveSummary } from "../../shared/play.ts";
import { roundUsd } from "../../shared/play.ts";
import type { LoadedSave, PlayDb, StoredSave, StoredTurn } from "./db.ts";

/** In-memory library used by tests. Charges survive a deleted turn, so a redo does not refund. */
export class MemoryPlayDb implements PlayDb {
  private readonly saves = new Map<string, StoredSave>();
  private readonly turns: StoredTurn[] = [];
  private readonly charges: { userId: string; costUsd: number }[] = [];

  async spent(userId: string): Promise<number> {
    return roundUsd(this.charges.filter((row) => row.userId === userId).reduce((n, row) => n + row.costUsd, 0));
  }

  async list(userId: string): Promise<SaveSummary[]> {
    return [...this.saves.values()]
      .filter((save) => save.userId === userId)
      .map((save) => ({
        id: save.id,
        configId: save.configId,
        title: save.title,
        turn: save.turn,
        ended: save.ended,
        updatedAt: save.updatedAt,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id)));
  }

  async load(userId: string, saveId: string): Promise<LoadedSave | null> {
    const save = this.saves.get(saveId);
    if (!save || save.userId !== userId) return null;
    return {
      ...structuredClone(save),
      turns: this.turns.filter((turn) => turn.saveId === saveId && turn.userId === userId).map((turn) => structuredClone(turn)),
    };
  }

  async insertSave(save: StoredSave): Promise<void> {
    if (this.saves.has(save.id)) throw new Error(`Save "${save.id}" already exists`);
    this.saves.set(save.id, structuredClone(save));
  }

  async updateSave(save: StoredSave): Promise<void> {
    const existing = this.saves.get(save.id);
    if (!existing || existing.userId !== save.userId) throw new Error(`Save "${save.id}" not found`);
    this.saves.set(save.id, structuredClone(save));
  }

  async appendTurn(turn: StoredTurn): Promise<void> {
    this.turns.push(structuredClone(turn));
  }

  async deleteTurn(userId: string, saveId: string, turnId: string): Promise<void> {
    const index = this.turns.findIndex((turn) => turn.id === turnId && turn.saveId === saveId && turn.userId === userId);
    if (index >= 0) this.turns.splice(index, 1);
  }

  async charge(userId: string, _saveId: string | null, costUsd: number): Promise<void> {
    if (costUsd <= 0) return;
    this.charges.push({ userId, costUsd });
  }
}
