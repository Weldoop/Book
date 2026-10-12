import { randomBytes } from "node:crypto";
import { BudgetExceededError, withBudget } from "@book/llm";
import type { BudgetedProvider } from "@book/llm";
import { createRuntime, newGame, openBook, playTurn } from "@book/runtime";
import type { TurnResult } from "@book/runtime";
import type { LLMProvider, State } from "@book/schema";
import { MemoryStore } from "@book/store";
import { emphasize, endingLines, rollLine, sceneLine } from "@book/harness";
import {
  capMessage,
  cleanInput,
  debugFromRecord,
  lastPlayerTurn,
  OPENING_INPUT,
  PERSON_CAP_USD,
  roundUsd,
  transcriptOf,
} from "../../shared/play.ts";
import type { LibraryView, PlayView, ShownLine } from "../../shared/play.ts";
import type { LoadedSave, PlayDb, StoredSave, StoredTurn } from "./db.ts";
import { findGame, listGames } from "./games.ts";

export interface PlayFailure {
  ok: false;
  status: number;
  error: string;
}

export interface PlaySuccess {
  ok: true;
  view: PlayView;
}

export type PlayOutcome = PlaySuccess | PlayFailure;

function fail(status: number, error: string): PlayFailure {
  return { ok: false, status, error };
}

function newSaveId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `web${stamp}${randomBytes(3).toString("hex")}`;
}

function newTurnId(): string {
  return randomBytes(8).toString("hex");
}

export function shownLines(result: TurnResult): ShownLine[] {
  const lines: ShownLine[] = [];
  const roll = rollLine(result);
  if (roll) lines.push({ kind: "note", text: roll });
  if (result.interlude?.trim()) lines.push({ kind: "note", text: result.interlude.trim() });
  const story = emphasize(result.narration, result.highlights, false).trim();
  if (story) lines.push({ kind: "story", text: story });
  for (const notice of result.notices) {
    if (notice.trim()) lines.push({ kind: "note", text: notice.trim() });
  }
  if (result.status?.trim()) lines.push({ kind: "status", text: result.status.trim() });
  const scene = sceneLine(result);
  if (scene) lines.push({ kind: "note", text: scene });
  for (const line of endingLines(result)) {
    lines.push({ kind: "story", text: line.replaceAll("/quit", "pick another save when you want to leave") });
  }
  return lines;
}

function storyEnded(state: State, outcome: string): boolean {
  if (outcome === "ended") return true;
  return Boolean(state.ending && !state.ending.continuable);
}

function toView(save: LoadedSave, spentUsd: number): PlayView {
  const last = save.turns.at(-1) ?? null;
  const editable = lastPlayerTurn(save.turns);
  return {
    id: save.id,
    configId: save.configId,
    title: save.title,
    turn: save.turn,
    ended: save.ended,
    suggestions: last?.suggestions ?? [],
    lines: transcriptOf(save.turns.map((turn) => ({ input: turn.input, lines: turn.lines }))),
    lastInput: editable?.input ?? null,
    debug: debugFromRecord(spentUsd, last?.record ?? null),
    spentUsd,
    capUsd: PERSON_CAP_USD,
  };
}

async function viewOf(db: PlayDb, userId: string, saveId: string): Promise<PlaySuccess | PlayFailure> {
  const save = await db.load(userId, saveId);
  if (!save) return fail(404, "That save is not on this account.");
  const spentUsd = await db.spent(userId);
  return { ok: true, view: toView(save, spentUsd) };
}

export async function library(db: PlayDb, userId: string): Promise<LibraryView> {
  const [games, saves, spentUsd] = await Promise.all([Promise.resolve(listGames()), db.list(userId), db.spent(userId)]);
  return { games, saves, spentUsd, capUsd: PERSON_CAP_USD };
}

async function playOn(
  configId: string,
  state: State,
  input: string,
  llm: BudgetedProvider,
): Promise<{ result: TurnResult; state: State }> {
  const config = findGame(configId);
  if (!config) throw new Error(`Unknown game ${configId}`);
  const store = new MemoryStore();
  await store.createSave(structuredClone(state));
  const rt = createRuntime({ config, store, llm });
  const result = await playTurn(rt, state.save_id, input);
  return { result, state: await store.loadSave(state.save_id) };
}

async function chargeBurned(db: PlayDb, userId: string, saveId: string | null, llm: BudgetedProvider): Promise<void> {
  const burned = roundUsd(llm.spent().cost_usd);
  if (burned > 0) await db.charge(userId, saveId, burned);
}

function stamp(save: StoredSave, state: State, outcome: string): StoredSave {
  return {
    ...save,
    state,
    turn: state.turn,
    ended: storyEnded(state, outcome),
    updatedAt: new Date().toISOString(),
  };
}

export async function openGame(db: PlayDb, userId: string, configId: unknown, llm: LLMProvider): Promise<PlayOutcome> {
  const id = typeof configId === "string" ? configId.trim() : "";
  const config = findGame(id);
  if (!config) return fail(400, "Choose Uplands or the pirate book.");
  const spentUsd = await db.spent(userId);
  const blocked = capMessage(spentUsd);
  if (blocked) return fail(402, blocked);

  const remaining = Math.max(PERSON_CAP_USD - spentUsd, 0);
  const budgeted = withBudget(llm, { maxCostUsd: remaining });
  const saveId = newSaveId();
  const store = new MemoryStore();
  const rt = createRuntime({ config, store, llm: budgeted });
  try {
    await newGame(rt, saveId);
    const seed = await store.loadSave(saveId);
    const opened = await openBook(rt, saveId);
    const state = await store.loadSave(saveId);
    const cost = roundUsd(budgeted.spent().cost_usd);
    const save: StoredSave = {
      id: saveId,
      userId,
      configId: config.id,
      title: config.meta.title,
      turn: state.turn,
      ended: opened ? storyEnded(state, opened.outcome) : false,
      state,
      updatedAt: new Date().toISOString(),
    };
    await db.insertSave(save);
    if (opened) {
      await db.appendTurn({
        id: newTurnId(),
        saveId,
        userId,
        input: OPENING_INPUT,
        outcome: opened.outcome,
        record: opened.record,
        stateBefore: seed,
        costUsd: cost,
        lines: shownLines(opened),
        suggestions: opened.suggestions ?? [],
      });
    }
    if (cost > 0) await db.charge(userId, saveId, cost);
    return viewOf(db, userId, saveId);
  } catch (err) {
    await chargeBurned(db, userId, null, budgeted);
    if (err instanceof BudgetExceededError) {
      const spent = await db.spent(userId);
      return fail(402, capMessage(Math.max(spent, PERSON_CAP_USD)) ?? capMessage(PERSON_CAP_USD) ?? "Cap reached.");
    }
    const message = err instanceof Error ? err.message : "The book did not open.";
    return fail(500, message);
  }
}

export async function readSave(db: PlayDb, userId: string, saveId: string): Promise<PlayOutcome> {
  return viewOf(db, userId, saveId);
}

async function commitPlayed(
  db: PlayDb,
  userId: string,
  save: LoadedSave,
  input: string,
  played: { result: TurnResult; state: State },
  cost: number,
): Promise<PlayOutcome> {
  const turn: StoredTurn = {
    id: newTurnId(),
    saveId: save.id,
    userId,
    input,
    outcome: played.result.outcome,
    record: played.result.record,
    stateBefore: structuredClone(save.state),
    costUsd: cost,
    lines: shownLines(played.result),
    suggestions: played.result.suggestions ?? [],
  };
  await db.appendTurn(turn);
  await db.updateSave(stamp(save, played.state, played.result.outcome));
  if (cost > 0) await db.charge(userId, save.id, cost);
  return viewOf(db, userId, save.id);
}

export async function takeTurn(db: PlayDb, userId: string, saveId: string, rawInput: unknown, llm: LLMProvider): Promise<PlayOutcome> {
  const parsed = cleanInput(rawInput);
  if (!parsed.ok) return fail(400, parsed.error);
  const save = await db.load(userId, saveId);
  if (!save) return fail(404, "That save is not on this account.");
  const spentUsd = await db.spent(userId);
  const blocked = capMessage(spentUsd);
  if (blocked) return fail(402, blocked);

  const budgeted = withBudget(llm, { maxCostUsd: Math.max(PERSON_CAP_USD - spentUsd, 0) });
  try {
    const played = await playOn(save.configId, save.state, parsed.text, budgeted);
    const cost = roundUsd(budgeted.spent().cost_usd);
    return commitPlayed(db, userId, save, parsed.text, played, cost);
  } catch (err) {
    await chargeBurned(db, userId, save.id, budgeted);
    if (err instanceof BudgetExceededError) {
      const spent = await db.spent(userId);
      return fail(402, capMessage(Math.max(spent, PERSON_CAP_USD)) ?? "Cap reached. Your save is intact.");
    }
    const message = err instanceof Error ? err.message : "The turn did not go through.";
    return fail(500, message);
  }
}

export async function redoTurn(db: PlayDb, userId: string, saveId: string, rawInput: unknown, llm: LLMProvider): Promise<PlayOutcome> {
  const parsed = cleanInput(rawInput);
  if (!parsed.ok) return fail(400, parsed.error);
  const save = await db.load(userId, saveId);
  if (!save) return fail(404, "That save is not on this account.");
  const previous = lastPlayerTurn(save.turns);
  if (!previous) return fail(400, "There is no line to edit yet.");
  const spentUsd = await db.spent(userId);
  const blocked = capMessage(spentUsd);
  if (blocked) return fail(402, blocked);

  const budgeted = withBudget(llm, { maxCostUsd: Math.max(PERSON_CAP_USD - spentUsd, 0) });
  try {
    const played = await playOn(save.configId, previous.stateBefore, parsed.text, budgeted);
    const cost = roundUsd(budgeted.spent().cost_usd);
    await db.deleteTurn(userId, save.id, previous.id);
    const rewound: LoadedSave = { ...save, state: structuredClone(previous.stateBefore), turn: previous.stateBefore.turn };
    return commitPlayed(db, userId, rewound, parsed.text, played, cost);
  } catch (err) {
    await chargeBurned(db, userId, save.id, budgeted);
    if (err instanceof BudgetExceededError) {
      const spent = await db.spent(userId);
      return fail(402, capMessage(Math.max(spent, PERSON_CAP_USD)) ?? "Cap reached. Your save is intact.");
    }
    const message = err instanceof Error ? err.message : "That line could not be played again.";
    return fail(500, message);
  }
}
