import type { SupabaseClient } from "@supabase/supabase-js";
import { StateSchema } from "@book/schema";
import type { State, TurnRecord } from "@book/schema";
import type { SaveSummary, ShownLine } from "../../shared/play.ts";
import { OPENING_INPUT, roundUsd, tailWindow } from "../../shared/play.ts";
import type { EditableTurn, PlayDb, ShownTurn, StoredSave, StoredTurn, TurnWindow } from "./db.ts";

interface SaveRow {
  id: string;
  user_id: string;
  config_id: string;
  title: string;
  turn: number;
  ended: boolean;
  state: unknown;
  updated_at: string;
}

interface TurnHeadRow {
  id: string;
  input: string;
  outcome: string;
  record: unknown;
  cost_usd: number | string;
  lines: unknown;
  suggestions: unknown;
  created_at: string;
}

interface ChargeRow {
  cost_usd: number | string;
}

function num(value: number | string): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asState(raw: unknown, where: string): State {
  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Corrupt save state (${where})`);
  return parsed.data;
}

function stateOrNull(raw: unknown): State | null {
  const parsed = StateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function asRecord(raw: unknown): TurnRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as TurnRecord;
}

function asLines(raw: unknown): ShownLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((line): line is ShownLine => {
    if (!line || typeof line !== "object") return false;
    const kind = (line as { kind?: unknown }).kind;
    const text = (line as { text?: unknown }).text;
    return (kind === "story" || kind === "status" || kind === "note") && typeof text === "string";
  });
}

function asSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function saveFrom(row: SaveRow): StoredSave {
  return {
    id: row.id,
    userId: row.user_id,
    configId: row.config_id,
    title: row.title,
    turn: row.turn,
    ended: row.ended,
    state: asState(row.state, row.id),
    updatedAt: row.updated_at,
  };
}

function headFrom(row: TurnHeadRow): ShownTurn {
  return {
    id: row.id,
    input: row.input,
    outcome: row.outcome,
    record: asRecord(row.record),
    costUsd: num(row.cost_usd),
    lines: asLines(row.lines),
    suggestions: asSuggestions(row.suggestions),
  };
}

/** Quote a PostgREST `or` value. Timestamps contain characters that otherwise break the filter. */
function quoteFilter(value: string): string {
  return `"${value.replaceAll('"', "")}"`;
}

async function expectOk(error: { message: string } | null, what: string): Promise<void> {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export class SupabasePlayDb implements PlayDb {
  constructor(private readonly client: SupabaseClient) {}

  async spent(userId: string): Promise<number> {
    const { data, error } = await this.client.from("charges").select("cost_usd").eq("user_id", userId);
    await expectOk(error, "spent");
    return roundUsd(((data ?? []) as ChargeRow[]).reduce((n, row) => n + num(row.cost_usd), 0));
  }

  async list(userId: string): Promise<SaveSummary[]> {
    const { data, error } = await this.client
      .from("saves")
      .select("id, config_id, title, turn, ended, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    await expectOk(error, "list saves");
    return ((data ?? []) as Omit<SaveRow, "state" | "user_id">[]).map((row) => ({
      id: row.id,
      configId: row.config_id,
      title: row.title,
      turn: row.turn,
      ended: row.ended,
      updatedAt: row.updated_at,
    }));
  }

  async loadSave(userId: string, saveId: string): Promise<StoredSave | null> {
    const saveResult = await this.client.from("saves").select("*").eq("user_id", userId).eq("id", saveId).maybeSingle();
    await expectOk(saveResult.error, "load save");
    if (!saveResult.data) return null;
    return saveFrom(saveResult.data as SaveRow);
  }

  async windowTurns(userId: string, saveId: string, beforeId: string | null, messages: number): Promise<TurnWindow> {
    const limit = Math.max(1, messages);
    let query = this.client
      .from("turns")
      .select("id, input, outcome, record, cost_usd, lines, suggestions, created_at")
      .eq("user_id", userId)
      .eq("save_id", saveId);
    if (beforeId) {
      const cursor = await this.client
        .from("turns")
        .select("id, created_at")
        .eq("user_id", userId)
        .eq("save_id", saveId)
        .eq("id", beforeId)
        .maybeSingle();
      await expectOk(cursor.error, "load turn cursor");
      const row = cursor.data as { id: string; created_at: string } | null;
      if (!row) return { turns: [], before: null };
      const at = quoteFilter(row.created_at);
      const id = quoteFilter(row.id);
      query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
    }
    const turnResult = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    await expectOk(turnResult.error, "load turns");
    const rows = (turnResult.data ?? []) as TurnHeadRow[];
    const moreBefore = rows.length > limit;
    const batch = rows.slice(0, limit).reverse().map(headFrom);
    const window = tailWindow(batch, limit, moreBefore);
    return { turns: window.turns, before: window.before };
  }

  async lastEditable(userId: string, saveId: string): Promise<EditableTurn | null> {
    const result = await this.client
      .from("turns")
      .select("id, state_before")
      .eq("user_id", userId)
      .eq("save_id", saveId)
      .neq("input", OPENING_INPUT)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    await expectOk(result.error, "load editable turn");
    const row = result.data as { id: string; state_before: unknown } | null;
    if (!row) return null;
    return { id: row.id, stateBefore: stateOrNull(row.state_before) };
  }

  async insertSave(save: StoredSave): Promise<void> {
    const { error } = await this.client.from("saves").insert({
      id: save.id,
      user_id: save.userId,
      config_id: save.configId,
      title: save.title,
      turn: save.turn,
      ended: save.ended,
      state: save.state,
      updated_at: save.updatedAt,
    });
    await expectOk(error, "insert save");
  }

  async updateSave(save: StoredSave): Promise<void> {
    const { error } = await this.client
      .from("saves")
      .update({
        turn: save.turn,
        ended: save.ended,
        state: save.state,
        updated_at: save.updatedAt,
      })
      .eq("user_id", save.userId)
      .eq("id", save.id);
    await expectOk(error, "update save");
  }

  async appendTurn(turn: StoredTurn): Promise<void> {
    const { error } = await this.client.from("turns").insert({
      id: turn.id,
      save_id: turn.saveId,
      user_id: turn.userId,
      input: turn.input,
      outcome: turn.outcome,
      record: turn.record,
      state_before: turn.stateBefore,
      cost_usd: turn.costUsd,
      lines: turn.lines,
      suggestions: turn.suggestions,
    });
    await expectOk(error, "append turn");
  }

  async deleteTurn(userId: string, saveId: string, turnId: string): Promise<void> {
    const { error } = await this.client.from("turns").delete().eq("user_id", userId).eq("save_id", saveId).eq("id", turnId);
    await expectOk(error, "delete turn");
  }

  async charge(userId: string, saveId: string | null, costUsd: number): Promise<void> {
    if (costUsd <= 0) return;
    const { error } = await this.client.from("charges").insert({
      user_id: userId,
      save_id: saveId,
      cost_usd: costUsd,
    });
    await expectOk(error, "charge");
  }
}
