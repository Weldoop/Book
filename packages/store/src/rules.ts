import { StateSchema } from "@book/schema";
import type { State, TurnCommit } from "@book/schema";

export function parseState(raw: unknown, where: string): State {
  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Corrupt save state (${where}): ${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

export function checkCommit(commit: TurnCommit, storedTurn: number): void {
  const { save_id, expected_turn, state, record } = commit;
  if (state.save_id !== save_id) {
    throw new Error(`commitTurn: state.save_id "${state.save_id}" does not match save "${save_id}"`);
  }
  if (expected_turn !== storedTurn) {
    throw new Error(`commitTurn: turn conflict on "${save_id}": expected ${expected_turn}, stored ${storedTurn}`);
  }
  const rolledBack = record.outcome === "rolled_back";
  const want = rolledBack ? expected_turn : expected_turn + 1;
  if (state.turn !== want) {
    throw new Error(
      `commitTurn: state.turn is ${state.turn} but a ${rolledBack ? "rolled-back" : "committed"} turn on "${save_id}" requires ${want}`,
    );
  }
  parseState(state, "commit");
}

export function checkUpdate(saveId: string, state: State, expectedTurn: number, storedTurn: number): void {
  if (state.save_id !== saveId) {
    throw new Error(`updateState: state.save_id "${state.save_id}" does not match save "${saveId}"`);
  }
  if (expectedTurn !== storedTurn) {
    throw new Error(`updateState: turn conflict on "${saveId}": expected ${expectedTurn}, stored ${storedTurn}`);
  }
  if (state.turn !== expectedTurn) {
    throw new Error(`updateState: state.turn (${state.turn}) must equal expectedTurn (${expectedTurn})`);
  }
  parseState(state, "update");
}
