import { ConfigSchema } from "@book/schema";
import type { Config, LLMUsage, State, TurnRecord } from "@book/schema";
import type { RuntimeApi, RuntimeLike, TurnResultLike } from "../src/index.ts";

export function makeConfig(profile: "novel" | "light" | "tabletop" = "light"): Config {
  return ConfigSchema.parse({
    id: "test-life",
    version: 1,
    meta: { title: "Test Life", tone: "wry and grounded", premise: "A student in Cardiff." },
    modules: ["core"],
    gm_style: { interludes: ["The moment wobbles."], rollback_note: "Try again." },
    presentation: { profile, status_line: ["money"] },
    time: { start: "2026-10-03T09:00" },
  });
}

function state(saveId: string, turn: number): State {
  return {
    version: 1,
    save_id: saveId,
    config_id: "test-life",
    config_version: 1,
    turn,
    clock: { now: "2026-10-03T09:00" },
    rng_seed: 1,
    entities: {},
    threads: [],
    beats: [],
    summaries: { chapters: [], story_so_far: "", last_compacted_turn: 0 },
    window: [],
    focus_next: [],
    scene: { index: 1, started_turn: 0, closed: false },
    notes: [],
    ending: null,
    endings_seen: [],
    ledger: [],
    modules: {},
  };
}

export interface FakeRuntimeOptions {
  /** Called for each model call; lets tests shape the outcome. */
  outcomeFor?: (turn: number, input: string) => TurnRecord["outcome"];
  answers?: (input: string) => string;
  throwAt?: number;
  roll?: { value: number; band: string; what: string; stat?: string };
}

/** A tiny stand-in for @book/runtime: one flat-context model call per turn, plus a repair call when asked. */
export function fakeRuntimeApi(opts: FakeRuntimeOptions = {}): RuntimeApi & { calls: string[]; created: unknown[] } {
  const calls: string[] = [];
  const created: unknown[] = [];
  const turns = new Map<string, number>();
  return {
    calls,
    created,
    createRuntime(o) {
      created.push(o);
      return { config: o.config, modules: o.modules ?? [], store: o.store, llm: o.llm } satisfies RuntimeLike;
    },
    async newGame(rt, saveId) {
      const s = state(saveId, 0);
      await rt.store.createSave(s);
      turns.set(saveId, 0);
      return s;
    },
    async playTurn(rt, saveId, input, hooks): Promise<TurnResultLike> {
      calls.push(input);
      const isOoc = input.startsWith("OOC:");
      const usage: LLMUsage[] = [];
      const call = async (purpose: string, tier: "strong" | "cheap"): Promise<string> => {
        const r = await rt.llm.complete({
          tier,
          system: [{ text: "static ".repeat(50), cache: true }],
          messages: [{ role: "user", content: `Player input: ${input}` }],
          max_tokens: 300,
          purpose,
        });
        usage.push(r.usage);
        return r.text;
      };
      let narration: string;
      let outcome: TurnRecord["outcome"] = "ok";
      let turn = turns.get(saveId) ?? 0;
      if (isOoc) {
        narration = opts.answers ? opts.answers(input) : await call("ooc", "cheap");
        if (opts.answers) await call("ooc", "cheap");
      } else {
        const next = turn + 1;
        if (opts.throwAt === next) throw new Error("runtime exploded");
        const text = await call("turn", "strong");
        outcome = opts.outcomeFor?.(next, input) ?? "ok";
        if (outcome !== "ok") await call("delta_repair", "strong");
        if (outcome === "rewritten") hooks?.onInterlude?.("The moment wobbles.");
        narration = (JSON.parse(text) as { narration?: string }).narration ?? text;
        if (outcome !== "rolled_back") {
          turn = next;
          turns.set(saveId, turn);
        }
      }
      const record: TurnRecord = {
        turn,
        kind: isOoc ? "ooc" : "act",
        input,
        narration,
        beat: null,
        delta: [],
        due: [],
        attempts:
          outcome === "ok"
            ? [{ kind: "draft" as const, violations: [] }]
            : [
                { kind: "draft" as const, violations: [] },
                { kind: outcome === "rewritten" ? ("rewrite_repair" as const) : ("delta_repair" as const), violations: [] },
              ],
        outcome,
        context_parts: [{ name: "static", tokens: 100, trimmed: false }],
        usage,
        at: "2026-10-03T09:00:00.000Z",
      };
      return {
        turn,
        kind: record.kind,
        narration,
        status: isOoc ? null : "£10 | fine",
        panel: ["Money: 10"],
        outcome,
        ...(outcome === "rewritten" ? { interlude: "The moment wobbles." } : {}),
        ...(opts.roll ? { roll: opts.roll } : {}),
        record,
      };
    },
  };
}

export function fixture(n: number): { id: string; inputs: { turn: number; text: string }[] } {
  return { id: "fx", inputs: Array.from({ length: n }, (_, i) => ({ turn: i + 1, text: `action number ${i + 1}` })) };
}
