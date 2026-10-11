export interface ContextBudget {
  contract: number;
  module_fragments: number;
  /** Reported only. The player input is never trimmed. */
  input: number;
  state_snapshot: number;
  due_events: number;
  threads: number;
  notes: number;
  world_sheet: number;
  entities_in_focus: number;
  window: number;
  beats: number;
  story_so_far: number;
}

/** Per-part token caps from docs/ARCHITECTURE.md section 6. Sum is ~4.9k. The phase target is 6,000. */
export const DEFAULT_BUDGET: ContextBudget = {
  contract: 700,
  module_fragments: 500,
  input: 50,
  state_snapshot: 600,
  due_events: 100,
  threads: 300,
  notes: 120,
  world_sheet: 350,
  entities_in_focus: 500,
  window: 800,
  beats: 400,
  story_so_far: 500,
};

export const WINDOW_TURNS = 6;
export const MAX_BEATS = 20;
export const MAX_FACTS_PER_ENTITY_IN_CONTEXT = 6;
export const DEFAULT_FOCUS_LIMIT = 10;

export function resolveBudget(partial?: Partial<ContextBudget>): ContextBudget {
  return { ...DEFAULT_BUDGET, ...(partial ?? {}) };
}
