import type { State, TurnRecord } from "@book/schema";
import type { SaveSummary, ShownLine } from "../../shared/play.ts";

/** A turn as shown in the log. The state from before the line is not loaded with it. */
export interface ShownTurn {
  id: string;
  input: string;
  outcome: string;
  record: TurnRecord | null;
  costUsd: number;
  lines: ShownLine[];
  suggestions: string[];
}

/** A page of turns, oldest first. `before` is set when older turns remain. */
export interface TurnWindow {
  turns: ShownTurn[];
  before: string | null;
}

/** The latest line the player typed, with the snapshot needed to play it again. */
export interface EditableTurn {
  id: string;
  stateBefore: State | null;
}

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

/** Persistence for one person's library. Implementations must not return another user's rows. */
export interface PlayDb {
  spent(userId: string): Promise<number>;
  list(userId: string): Promise<SaveSummary[]>;
  loadSave(userId: string, saveId: string): Promise<StoredSave | null>;
  /**
   * Whole turns that fill about `messages` transcript lines.
   * Pass `beforeId` to take the page older than that turn. Null starts at the latest turn.
   */
  windowTurns(userId: string, saveId: string, beforeId: string | null, messages: number): Promise<TurnWindow>;
  lastEditable(userId: string, saveId: string): Promise<EditableTurn | null>;
  insertSave(save: StoredSave): Promise<void>;
  updateSave(save: StoredSave): Promise<void>;
  appendTurn(turn: StoredTurn): Promise<void>;
  deleteTurn(userId: string, saveId: string, turnId: string): Promise<void>;
  /** Money already spent at the provider, including a call that did not commit. */
  charge(userId: string, saveId: string | null, costUsd: number): Promise<void>;
}
