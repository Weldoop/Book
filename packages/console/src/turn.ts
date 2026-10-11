import { randomBytes } from "node:crypto";
import { BudgetExceededError, withBudget } from "@book/llm";
import type { LLMProvider } from "@book/schema";
import { StateSchema } from "@book/schema";
import type { State } from "@book/schema";
import { MemoryStore } from "@book/store";
import { createRuntime, newGame, openBook, playTurn } from "@book/runtime";
import type { TurnResult } from "@book/runtime";
import { findGame, listGames } from "./games.ts";
import { presentTurn } from "./lines.ts";
import type { ConsoleLine, Presented } from "./lines.ts";

export const MAX_INPUT_CHARS = 2000;

/**
 * A Vercel function has nowhere to keep a save between requests. The browser holds the
 * state and sends it back with the next line.
 */
export interface TurnBody {
  game?: unknown;
  input?: unknown;
  state?: unknown;
  spentUsd?: unknown;
}

export interface HandleOptions {
  llm: LLMProvider;
  maxCostUsd: number;
  newSaveId?: () => string;
}

export interface TurnOk extends Presented {
  ok: true;
  title: string;
  state: State;
  spentUsd: number;
}

export interface TurnErr {
  ok: false;
  error: string;
  lines: ConsoleLine[];
  suggestions: string[];
  ended: false;
  state?: State;
  spentUsd?: number;
}

export type TurnResponse = TurnOk | TurnErr;

export function newSaveId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `phone${stamp}${randomBytes(3).toString("hex")}`;
}

function fail(error: string, state?: State, spentUsd?: number): TurnErr {
  return {
    ok: false,
    error,
    lines: [],
    suggestions: [],
    ended: false,
    ...(state ? { state } : {}),
    ...(spentUsd !== undefined ? { spentUsd } : {}),
  };
}

function spentOf(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function costOf(result: TurnResult): number {
  const sum = result.record.usage.reduce((n, usage) => n + usage.cost_usd, 0);
  return Math.round(sum * 1e6) / 1e6;
}

function parseExisting(raw: unknown): State | null {
  if (raw == null) return null;
  const parsed = StateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function handleTurn(body: TurnBody, opts: HandleOptions): Promise<TurnResponse> {
  const gameId = typeof body.game === "string" ? body.game : "";
  const config = findGame(gameId);
  if (!config) {
    const names = listGames().map((game) => game.id).join(" or ");
    return fail(`Unknown game. Choose ${names}.`);
  }

  const spentUsd = spentOf(body.spentUsd);
  const existing = body.state == null ? null : parseExisting(body.state);
  if (body.state != null && !existing) return fail("This save could not be read. /new starts again.");
  if (existing && existing.config_id !== config.id) {
    return fail(`That save belongs to ${existing.config_id}. /new starts again.`, existing, spentUsd);
  }
  if (spentUsd >= opts.maxCostUsd) {
    return fail(
      `Stopping: max cost $${opts.maxCostUsd} reached ($${spentUsd.toFixed(4)} spent). Your save is intact.`,
      existing ?? undefined,
      spentUsd,
    );
  }

  const text = typeof body.input === "string" ? body.input.trim() : "";
  if (text.length > MAX_INPUT_CHARS) {
    return fail("That line is too long. Try a shorter one.", existing ?? undefined, spentUsd);
  }
  if (existing && (text === "/new" || text === "/quit")) {
    return fail("Type /new to discard this save and pick a game. Nothing was sent.", existing, spentUsd);
  }

  const llm = withBudget(opts.llm, { maxCostUsd: Math.max(opts.maxCostUsd - spentUsd, 0) });
  const store = new MemoryStore();
  const rt = createRuntime({ config, store, llm });

  if (!existing) {
    const saveId = opts.newSaveId?.() ?? newSaveId();
    await newGame(rt, saveId);
    const t0 = performance.now();
    const opened = await openBook(rt, saveId);
    const state = await store.loadSave(saveId);
    if (!opened) {
      const premise = config.meta.premise.trim();
      return {
        ok: true,
        title: config.meta.title,
        lines: [
          ...(premise ? [{ kind: "story" as const, text: premise }] : []),
          { kind: "note", text: "One line is one turn. /new starts over." },
        ],
        suggestions: [],
        ended: false,
        state,
        spentUsd,
      };
    }
    const presented = presentTurn(opened, { profile: config.presentation.profile, wallMs: performance.now() - t0 });
    presented.lines.push({ kind: "note", text: "One line is one turn. /new starts over." });
    return {
      ok: true,
      title: config.meta.title,
      ...presented,
      state,
      spentUsd: Math.round((spentUsd + costOf(opened)) * 1e6) / 1e6,
    };
  }

  try {
    await store.createSave(existing);
  } catch (err) {
    const message = err instanceof Error ? err.message : "This save could not be read.";
    return fail(message, existing, spentUsd);
  }

  const t0 = performance.now();
  let result: TurnResult;
  try {
    result = await playTurn(rt, existing.save_id, text.length === 0 ? "..." : text);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return fail(`Stopping: ${err.message}. Your save is intact.`, existing, spentUsd);
    }
    throw err;
  }
  const state = await store.loadSave(existing.save_id);
  const presented = presentTurn(result, { profile: config.presentation.profile, wallMs: performance.now() - t0 });
  return {
    ok: true,
    title: config.meta.title,
    ...presented,
    state,
    spentUsd: Math.round((spentUsd + costOf(result)) * 1e6) / 1e6,
  };
}
