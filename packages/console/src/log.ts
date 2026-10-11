import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StateSchema, type State, type TurnRecord } from "@book/schema";
import { assertSafeSaveId } from "@book/store";
import type { ConsoleLine } from "./lines.ts";

export const MAX_SHOWN_LINES = 4_000;
export const MAX_SHOWN_CHARS = 8_000;

const KINDS = new Set<ConsoleLine["kind"]>(["story", "status", "note", "error"]);

export interface LoggedHistory {
  saveId: string;
  configId: string;
  title: string;
  lines: ConsoleLine[];
  spentUsd: number;
  state: State;
}

export interface LoggedTurn {
  saveId: string;
  configId: string;
  title: string;
  /** Null on the opening, which has no player line. */
  input: string | null;
  turn: number;
  outcome: string | null;
  lines: ConsoleLine[];
  spentUsd: number;
  state: State;
  record?: TurnRecord;
}

/** Keeps a review copy of what the player was shown. The browser stays the save. */
export interface SessionLog {
  /** Write the phone's existing scrollback once. A later call leaves the file in place. */
  archive(entry: LoggedHistory): Promise<boolean>;
  append(entry: LoggedTurn): Promise<void>;
}

const tails = new Map<string, Promise<unknown>>();

function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  tails.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/** Keep only lines the console itself would have drawn. */
export function shownLines(raw: unknown): ConsoleLine[] {
  if (!Array.isArray(raw)) return [];
  const out: ConsoleLine[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SHOWN_LINES) break;
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    const text = (item as { text?: unknown }).text;
    if (typeof kind !== "string" || !KINDS.has(kind as ConsoleLine["kind"])) continue;
    if (typeof text !== "string") continue;
    out.push({ kind: kind as ConsoleLine["kind"], text: text.length > MAX_SHOWN_CHARS ? text.slice(0, MAX_SHOWN_CHARS) : text });
  }
  return out;
}

function header(entry: { title: string; saveId: string; configId: string }): string {
  return `${entry.title}\nsave ${entry.saveId}\nconfig ${entry.configId}\n`;
}

function block(lines: ConsoleLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

/**
 * One directory per save under `root`: transcript.txt for reading, session.jsonl for the
 * committed turns, turns.jsonl for the engine record, state.json for the latest save.
 */
export class FileSessionLog implements SessionLog {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private dir(saveId: string): string {
    assertSafeSaveId(saveId);
    return join(this.root, saveId);
  }

  archive(entry: LoggedHistory): Promise<boolean> {
    return serial(entry.saveId, async () => {
      const key = this.dir(entry.saveId);
      await mkdir(key, { recursive: true });
      const sessionPath = join(key, "session.jsonl");
      try {
        await readFile(sessionPath, "utf8");
        return false;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      const lines = shownLines(entry.lines);
      const at = new Date().toISOString();
      const transcript = `${header(entry)}\n--- on the phone ---\n${block(lines)}\n`;
      await writeFile(join(key, "transcript.txt"), transcript, "utf8");
      await writeFile(
        sessionPath,
        `${JSON.stringify({ type: "recovered", at, title: entry.title, config_id: entry.configId, spent_usd: entry.spentUsd, lines })}\n`,
        "utf8",
      );
      await writeFile(join(key, "state.json"), `${JSON.stringify(entry.state, null, 2)}\n`, "utf8");
      return true;
    });
  }

  append(entry: LoggedTurn): Promise<void> {
    return serial(entry.saveId, async () => {
      const key = this.dir(entry.saveId);
      await mkdir(key, { recursive: true });
      const sessionPath = join(key, "session.jsonl");
      let existing = "";
      try {
        existing = await readFile(sessionPath, "utf8");
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      const at = new Date().toISOString();
      const prompt = entry.input === null ? "" : `> ${entry.input}\n`;
      const turnBlock = `--- turn ${entry.turn}${entry.outcome ? ` ${entry.outcome}` : ""} ---\n${prompt}${block(entry.lines)}\n`;
      if (existing === "") {
        await writeFile(join(key, "transcript.txt"), `${header(entry)}\n${turnBlock}`, "utf8");
      } else {
        await appendFile(join(key, "transcript.txt"), `\n${turnBlock}`, "utf8");
      }
      const row = {
        type: "turn",
        at,
        turn: entry.turn,
        input: entry.input,
        outcome: entry.outcome,
        spent_usd: entry.spentUsd,
        lines: entry.lines,
        usage: entry.record?.usage ?? [],
        context_parts: entry.record?.context_parts ?? [],
      };
      await appendFile(sessionPath, `${JSON.stringify(row)}\n`, "utf8");
      if (entry.record) {
        await appendFile(join(key, "turns.jsonl"), `${JSON.stringify(entry.record)}\n`, "utf8");
      }
      await writeFile(join(key, "state.json"), `${JSON.stringify(entry.state, null, 2)}\n`, "utf8");
    });
  }
}

export interface ResumedConsole {
  game: string;
  title: string;
  lines: ConsoleLine[];
  spentUsd: number;
  state: State;
}

interface SessionRow {
  type?: unknown;
  title?: unknown;
  config_id?: unknown;
  spent_usd?: unknown;
  input?: unknown;
  lines?: unknown;
}

/** Rebuild the phone scrollback from a session log. A bad row is skipped. */
export function replaySessionLog(jsonl: string): { title: string; configId: string; lines: ConsoleLine[]; spentUsd: number } {
  let title = "";
  let configId = "";
  let spentUsd = 0;
  const lines: ConsoleLine[] = [];
  for (const raw of jsonl.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let row: SessionRow;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      row = parsed as SessionRow;
    } catch {
      continue;
    }
    if (row.type === "recovered") {
      if (typeof row.title === "string") title = row.title;
      if (typeof row.config_id === "string") configId = row.config_id;
      if (typeof row.spent_usd === "number") spentUsd = row.spent_usd;
      lines.splice(0, lines.length, ...shownLines(row.lines));
      continue;
    }
    if (row.type !== "turn") continue;
    if (typeof row.spent_usd === "number") spentUsd = row.spent_usd;
    if (typeof row.input === "string" && row.input.length > 0) {
      lines.push({ kind: "note", text: `> ${row.input}` });
    }
    lines.push(...shownLines(row.lines));
  }
  return {
    title,
    configId,
    spentUsd,
    lines: lines.length > MAX_SHOWN_LINES ? lines.slice(-MAX_SHOWN_LINES) : lines,
  };
}

/** The newest save under `root`, or null when none of them can be read. */
export async function readLatestSession(root: string): Promise<ResumedConsole | null> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  const candidates: { name: string; mtime: number }[] = [];
  for (const name of names) {
    try {
      assertSafeSaveId(name);
    } catch {
      continue;
    }
    try {
      const info = await stat(join(root, name, "state.json"));
      candidates.push({ name, mtime: info.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  let state: State | null = null;
  let dir = "";
  for (const candidate of candidates) {
    const next = join(root, candidate.name);
    try {
      state = StateSchema.parse(JSON.parse(await readFile(join(next, "state.json"), "utf8")));
      dir = next;
      break;
    } catch {
      state = null;
    }
  }
  if (!state) return null;
  let played = { title: "", configId: state.config_id, lines: [] as ConsoleLine[], spentUsd: 0 };
  try {
    played = replaySessionLog(await readFile(join(dir, "session.jsonl"), "utf8"));
  } catch {
    // The save still loads. The scrollback stays empty until the next turn.
  }
  return {
    game: state.config_id,
    title: played.title,
    lines: played.lines,
    spentUsd: played.spentUsd,
    state,
  };
}

export function sessionLogFromEnv(env: Record<string, string | undefined>): SessionLog | undefined {
  const raw = env.BOOK_CONSOLE_LOG?.trim();
  if (!raw) return undefined;
  return new FileSessionLog(raw);
}

/**
 * Where `/api/resume` reads. A writable log wins so local play stays on
 * `.book-console`. `BOOK_CONSOLE_RESUME` is the read-only copy shipped in the
 * Vercel bundle; turns must not append there.
 */
export function resumeRoot(env: Record<string, string | undefined>): string | undefined {
  const log = env.BOOK_CONSOLE_LOG?.trim();
  if (log) return log;
  const resume = env.BOOK_CONSOLE_RESUME?.trim();
  return resume || undefined;
}
