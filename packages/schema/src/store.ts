import type { TurnDraft, Violation } from "./delta.ts";
import type { LLMUsage } from "./llm.ts";
import type { State } from "./state.ts";

export type TurnKind = "act" | "continue" | "ooc";

export interface Attempt {
  kind: "draft" | "delta_repair" | "rewrite_repair";
  draft?: unknown;
  violations: Violation[];
  usage?: LLMUsage;
}

export interface TurnRecord {
  turn: number;
  kind: TurnKind;
  input: string;
  narration: string | null;
  beat: string | null;
  delta: unknown[];
  fate?: number;
  due: string[];
  attempts: Attempt[];
  outcome: "ok" | "repaired" | "rewritten" | "rolled_back";
  interlude?: string;
  context_parts: { name: string; tokens: number; trimmed: boolean }[];
  usage: LLMUsage[];
  at: string;
}

export interface TurnCommit {
  save_id: string;
  expected_turn: number;
  state: State;
  record: TurnRecord;
}

export interface SaveMeta {
  save_id: string;
  config_id: string;
  config_version: number;
  turn: number;
}

export interface Store {
  createSave(state: State): Promise<void>;
  loadSave(saveId: string): Promise<State>;
  /** Atomic. Throws if expected_turn does not match the stored turn. */
  commitTurn(commit: TurnCommit): Promise<void>;
  /** Rolled-back turns and background calls (compaction) are logged without changing state. */
  appendLog(saveId: string, entry: unknown): Promise<void>;
  /** Replace state without advancing a turn (used by compaction). */
  updateState(saveId: string, state: State, expectedTurn: number): Promise<void>;
  listSaves(): Promise<SaveMeta[]>;
  readTurnRecords(saveId: string): Promise<TurnRecord[]>;
}

export type { TurnDraft };
