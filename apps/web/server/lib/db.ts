import type { State, TurnRecord } from "@book/schema";
import type { SaveSummary, ShownLine } from "../../shared/play.ts";

export interface StoredTurn {
  id: string;
  saveId: string;
  userId: string;
  input: string;
  outcome: string;
  record: TurnRecord;
  stateBefore: State;
  costUsd: number;
  lines: ShownLine[];
  suggestions: string[];
}

export interface StoredSave {
  id: string;
  userId: string;
  configId: string;
  title: string;
  turn: number;
  ended: boolean;
  state: State;
  updatedAt: string;
}

export interface LoadedSave extends StoredSave {
  turns: StoredTurn[];
}

/** Persistence for one person's library. Implementations must not return another user's rows. */
export interface PlayDb {
  spent(userId: string): Promise<number>;
  list(userId: string): Promise<SaveSummary[]>;
  load(userId: string, saveId: string): Promise<LoadedSave | null>;
  insertSave(save: StoredSave): Promise<void>;
  updateSave(save: StoredSave): Promise<void>;
  appendTurn(turn: StoredTurn): Promise<void>;
  deleteTurn(userId: string, saveId: string, turnId: string): Promise<void>;
  /** Money already spent at the provider, including a call that did not commit. */
  charge(userId: string, saveId: string | null, costUsd: number): Promise<void>;
}
