import { lastPlayerTurn, roundUsd, tailWindow } from "../../shared/play.ts";
import type { SaveSummary } from "../../shared/play.ts";
import type { EditableTurn, PlayDb, ShownTurn, StoredSave, StoredTurn, TurnWindow } from "./db.ts";

/** In-memory library used by tests. Charges survive a deleted turn, so a redo does not refund. */
export class MemoryPlayDb implements PlayDb {
  private readonly saves = new Map<string, StoredSave>();
  private readonly turns: StoredTurn[] = [];
  private readonly charges: { userId: string; costUsd: number }[] = [];
  private readonly missingState = new Set<string>();

  /** Test hook: the latest player line keeps no snapshot, as with an imported history. */
  forgetStateBefore(userId: string, saveId: string): void {
    const previous = lastPlayerTurn(this.ownedTurns(userId, saveId));
    if (previous) this.missingState.add(previous.id);
  }

  private ownedTurns(userId: string, saveId: string): StoredTurn[] {
    return this.turns.filter((turn) => turn.saveId === saveId && turn.userId === userId);
  }

  private shown(turn: StoredTurn): ShownTurn {
    return {
      id: turn.id,
      input: turn.input,
      outcome: turn.outcome,
      record: turn.record,
      costUsd: turn.costUsd,
      lines: turn.lines,
      suggestions: turn.suggestions,
    };
  }

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

  async loadSave(userId: string, saveId: string): Promise<StoredSave | null> {
    const save = this.saves.get(saveId);
    if (!save || save.userId !== userId) return null;
    return structuredClone(save);
  }

  async windowTurns(userId: string, saveId: string, beforeId: string | null, messages: number): Promise<TurnWindow> {
    const owned = this.ownedTurns(userId, saveId);
    let end = owned.length;
    if (beforeId) {
      const index = owned.findIndex((turn) => turn.id === beforeId);
      if (index < 0) return { turns: [], before: null };
      end = index;
    }
    const older = owned.slice(0, end);
    const batch = older.slice(Math.max(0, older.length - Math.max(1, messages)));
    const window = tailWindow(
      batch.map((turn) => this.shown(turn)),
      messages,
      older.length > batch.length,
    );
    return { turns: window.turns, before: window.before };
  }

  async lastEditable(userId: string, saveId: string): Promise<EditableTurn | null> {
    const previous = lastPlayerTurn(this.ownedTurns(userId, saveId));
    if (!previous) return null;
    return {
      id: previous.id,
      stateBefore: this.missingState.has(previous.id) ? null : structuredClone(previous.stateBefore),
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
