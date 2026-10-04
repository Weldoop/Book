import type { ZodTypeAny } from "zod";
import type { Config } from "./config.ts";
import type { Op, OpName, Violation } from "./delta.ts";
import type { State } from "./state.ts";

export interface DueItem {
  id: string;
  kind: "scheduled" | "conditional" | "random";
  text: string;
  entities: string[];
  thread?: { kind: "commitment" | "goal" | "debt" | "mystery" | "callback"; text: string };
}

export interface Rng {
  next(): number;
}

export interface RenderOutput {
  status?: string;
  panel?: string[];
}

/** Contract implemented by every game mechanic. Core is a module too. Functions are pure. */
export interface Module {
  id: string;
  configSchema?: ZodTypeAny;
  /** Initial value for state.modules[id]. */
  initState(config: Config): unknown;
  /** Ops this module owns. */
  ops: OpName[];
  validateOp(op: Op, index: number, state: State, config: Config): Violation[];
  /** Returns a new state; must not mutate its input. */
  applyOp(op: Op, state: State, config: Config): State;
  /** Short rules shown to the model only when this module is active. */
  promptFragment(config: Config): string;
  /** Entity ids to pull into context for this input. */
  focus(state: State, input: string, config: Config): string[];
  /** Items firing between two clock times. Called by the engine once per turn. */
  due(state: State, config: Config, from: string, to: string, rng: Rng): DueItem[];
  /** Compact text lines for the state snapshot in the context. */
  snapshot(state: State, config: Config): string[];
  /** Deterministic, player-facing output. */
  render(state: State, config: Config): RenderOutput;
}
