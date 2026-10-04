import { BudgetExceededError } from "@book/llm";

export interface RunControl {
  maxTurns?: number;
  /** Checked before each input; return a reason to stop, for example when a cap is reached. */
  stopCheck?: () => string | undefined;
  onLine?: (line: string) => void;
}

export function stopReasonFor(err: unknown): string | undefined {
  return err instanceof BudgetExceededError ? err.message : undefined;
}
