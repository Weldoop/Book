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
  scene_ended?: boolean;
  highlights?: string[];
  chapter_title?: string;
  chapter_index?: number;
  /** Engine-printed warnings under the narration. Absent on older stand-ins. */
  notices?: string[];
  /** Short offers for the next line. Absent when the turn gave none. */
  suggestions?: string[];
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
    hooks?: { onInterlude?(text: string): void; onReleased?(result: TurnResultLike): void },
  ): Promise<TurnResultLike>;
  /** Deals the first chapter when the config asks for one. Absent runtimes skip it. */
  openBook?(rt: RuntimeLike, saveId: string): Promise<TurnResultLike | null>;
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
  return {
    createRuntime: api.createRuntime,
    newGame: api.newGame,
    playTurn: api.playTurn,
    ...(api.openBook ? { openBook: api.openBook } : {}),
  };
}
