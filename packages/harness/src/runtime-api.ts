import type { Config, LLMProvider, Module, State, Store, TurnKind, TurnRecord } from "@book/schema";

/** Structural copy of the `@book/runtime` surface the harness uses, so library code never imports the runtime package. */
export interface RuntimeLike {
  config: Config;
  modules: Module[];
  store: Store;
  llm: LLMProvider;
}

export interface TurnResultLike {
  turn: number;
  kind: TurnKind;
  narration: string;
  status: string | null;
  panel: string[];
  outcome: TurnRecord["outcome"];
  interlude?: string;
  roll?: { value: number; band: string; what: string; stat?: string };
  ending?: { id: string; title: string; text: string; continuation?: string };
  record: TurnRecord;
}

export interface CreateRuntimeOptions {
  config: Config;
  store: Store;
  llm: LLMProvider;
  modules?: Module[];
  /** Ask for the delta before the narration (section 5.3 streaming note). Ignored by runtimes that do not support it. */
  deltaFirst?: boolean;
  /** Keep every model reply verbatim in the turn log. */
  logRaw?: boolean;
}

export interface RuntimeApi {
  createRuntime(opts: CreateRuntimeOptions): RuntimeLike;
  newGame(rt: RuntimeLike, saveId: string): Promise<State>;
  playTurn(
    rt: RuntimeLike,
    saveId: string,
    input: string,
    hooks?: { onInterlude?(text: string): void },
  ): Promise<TurnResultLike>;
}

export async function loadRuntimeApi(): Promise<RuntimeApi> {
  const specifier = "@book/runtime";
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not load @book/runtime (${msg}). Has the turn runtime been built yet?`);
  }
  const api = mod as Partial<RuntimeApi>;
  if (!api.createRuntime || !api.newGame || !api.playTurn) {
    throw new Error("@book/runtime must export createRuntime, newGame and playTurn");
  }
  return { createRuntime: api.createRuntime, newGame: api.newGame, playTurn: api.playTurn };
}
