import {
  applyDraft,
  classifyInput,
  collectDue,
  createInitialState,
  diffMinutes,
  pickInterlude,
  rollFate,
  severityOf,
  stripOocPrefix,
  validateDraft,
} from "@book/engine";
import {
  describeOps,
  applyCompaction,
  buildCompactionRequest,
  buildOocContext,
  buildRepairContext,
  buildTurnContext,
  parseCompactionResult,
  shouldCompact,
} from "@book/context";
import { getActiveModules, renderView } from "@book/modules";
import type {
  Attempt,
  Config,
  LLMProvider,
  LLMRequest,
  LLMUsage,
  Module,
  State,
  Store,
  TurnDraft,
  TurnKind,
  TurnRecord,
  Violation,
} from "@book/schema";
import { parseDeltaRepair, parseDraftText } from "./parse.ts";
import { runOffscreen } from "./offscreen.ts";

export interface Runtime {
  config: Config;
  modules: Module[];
  store: Store;
  llm: LLMProvider;
  outputOrder: "narration_first" | "delta_first";
}

export interface TurnResult {
  turn: number;
  kind: TurnKind;
  narration: string;
  status: string | null;
  panel: string[];
  outcome: TurnRecord["outcome"];
  interlude?: string;
  record: TurnRecord;
}

export interface TurnHooks {
  onInterlude?(text: string): void;
}

export function createRuntime(opts: {
  config: Config;
  store: Store;
  llm: LLMProvider;
  modules?: Module[];
  outputOrder?: "narration_first" | "delta_first";
  deltaFirst?: boolean;
}): Runtime {
  return {
    config: opts.config,
    store: opts.store,
    llm: opts.llm,
    modules: opts.modules ?? getActiveModules(opts.config),
    outputOrder: opts.outputOrder ?? (opts.deltaFirst ? "delta_first" : "narration_first"),
  };
}

export async function newGame(rt: Runtime, saveId: string): Promise<State> {
  const state = createInitialState(rt.config, rt.modules, saveId);
  await rt.store.createSave(state);
  return state;
}

const TURN_MAX_TOKENS = 1000;
const MAX_REPAIRS = 2;

interface Evaluated {
  draft: TurnDraft | null;
  text: string;
  violations: Violation[];
}

function evaluate(state: State, rt: Runtime, text: string): Evaluated {
  const parsed = parseDraftText(text);
  if (!parsed.ok) {
    return {
      draft: null,
      text,
      violations: [
        {
          severity: "fixable",
          code: "unparseable",
          message: `The reply could not be read as the required JSON object (${parsed.error}). Reply with exactly one JSON object with keys narration, delta, beat.`,
        },
      ],
    };
  }
  const result = validateDraft(state, rt.config, rt.modules, parsed.draft);
  return { draft: parsed.draft, text, violations: result.violations };
}

function view(rt: Runtime, state: State) {
  const v = renderView(rt.config, state, rt.modules);
  return { status: v.status, panel: v.panel };
}

async function playOoc(rt: Runtime, state: State, rawInput: string): Promise<TurnResult> {
  const input = stripOocPrefix(rawInput);
  const ctx = buildOocContext({ config: rt.config, state, modules: rt.modules, input });
  const res = await rt.llm.complete({
    tier: "cheap",
    purpose: "ooc",
    system: ctx.system,
    messages: ctx.messages,
    max_tokens: 300,
  });
  const record: TurnRecord = {
    turn: state.turn,
    kind: "ooc",
    input: rawInput,
    narration: res.text.trim(),
    beat: null,
    delta: [],
    due: [],
    attempts: [],
    outcome: "ok",
    context_parts: ctx.parts,
    usage: [res.usage],
    at: new Date().toISOString(),
  };
  await rt.store.appendLog(state.save_id, { type: "ooc", record });
  return { turn: state.turn, kind: "ooc", narration: record.narration ?? "", ...view(rt, state), outcome: "ok", record };
}

export async function playTurn(rt: Runtime, saveId: string, rawInput: string, hooks: TurnHooks = {}): Promise<TurnResult> {
  const state = await rt.store.loadSave(saveId);
  const kind = classifyInput(rawInput);
  if (kind === "ooc") return playOoc(rt, state, rawInput);

  const { config, modules } = rt;
  const input = kind === "continue" ? "..." : rawInput.trim();
  const fate = rollFate(state, config);
  const due = collectDue(state, config, modules);
  const ctx = buildTurnContext({
    config,
    state,
    modules,
    input,
    kind,
    due,
    ...(fate !== undefined ? { fate } : {}),
    outputOrder: rt.outputOrder,
  });

  const usages: LLMUsage[] = [];
  const attempts: Attempt[] = [];
  const call = async (req: LLMRequest) => {
    const res = await rt.llm.complete(req);
    usages.push(res.usage);
    return res;
  };

  const first = await call({
    tier: "strong",
    purpose: "turn",
    system: ctx.system,
    messages: ctx.messages,
    max_tokens: TURN_MAX_TOKENS,
    json: true,
  });
  let current = evaluate(state, rt, first.text);
  attempts.push({ kind: "draft", draft: current.draft ?? current.text, violations: current.violations, usage: first.usage });

  let repairs = 0;
  let rewrote = false;
  let interlude: string | undefined;

  while (current.violations.length > 0 && repairs < MAX_REPAIRS) {
    const severity = severityOf(current.violations);
    const formatFailure = current.draft === null;
    const canPatchDelta = severity === "fixable" && !formatFailure && repairs === 0;

    if (formatFailure && repairs === 0) {
      // The reply was not valid JSON. Reformat it (or retry if empty); the story content is not in question, so no interlude.
      const raw = current.text.trim();
      const res = raw
        ? await call({
            tier: "cheap",
            purpose: "format_repair",
            system: [
              {
                text: `Convert the Game Master reply below into ONE JSON object and return only that JSON. Keys: "narration" (string, keep the story text exactly), "delta" (array of ops, may be empty), "beat" (one line under 20 words), optional "focus_next" (array of entity ids). Allowed ops:\n${describeOps(modules)}\nIf the reply already contains the JSON, extract and fix it. Do not add commentary.`,
                cache: true,
              },
            ],
            messages: [{ role: "user", content: raw }],
            max_tokens: TURN_MAX_TOKENS,
            json: true,
          })
        : await call({ tier: "strong", purpose: "format_repair", system: ctx.system, messages: ctx.messages, max_tokens: TURN_MAX_TOKENS, json: true });
      current = evaluate(state, rt, res.text);
      attempts.push({ kind: "format_repair", draft: current.draft ?? current.text, violations: current.violations, usage: res.usage });
    } else if (canPatchDelta && current.draft) {
      const rc = buildRepairContext({
        kind: "delta_repair",
        config,
        state,
        modules,
        input,
        draftText: JSON.stringify(current.draft.delta),
        violations: current.violations,
        narration: current.draft.narration,
      });
      const res = await call({ tier: "cheap", purpose: "delta_repair", system: rc.system, messages: rc.messages, max_tokens: 400, json: true });
      const fixed = parseDeltaRepair(res.text);
      if (fixed.ok) {
        const candidate: TurnDraft = { ...current.draft, delta: fixed.delta, beat: fixed.beat ?? current.draft.beat };
        const result = validateDraft(state, config, modules, candidate);
        current = { draft: candidate, text: JSON.stringify(candidate), violations: result.violations };
      } else {
        current = {
          draft: current.draft,
          text: current.text,
          violations: [{ severity: "fixable", code: "repair_unreadable", message: `The delta repair could not be read (${fixed.error}).` }],
        };
      }
      attempts.push({ kind: "delta_repair", draft: current.draft ?? current.text, violations: current.violations, usage: res.usage });
    } else {
      if (!rewrote && !formatFailure && severity === "game_breaking") {
        interlude = pickInterlude(state, config);
        hooks.onInterlude?.(interlude);
      }
      rewrote = true;
      const rc = buildRepairContext({
        kind: "rewrite_repair",
        config,
        state,
        modules,
        input,
        turn_kind: kind,
        draftText: current.text,
        violations: current.violations,
        ...(current.draft ? { narration: current.draft.narration } : {}),
        ...(fate !== undefined ? { fate } : {}),
        due,
        outputOrder: rt.outputOrder,
      });
      const res = await call({
        tier: "strong",
        purpose: "rewrite_repair",
        system: rc.system,
        messages: rc.messages,
        max_tokens: TURN_MAX_TOKENS,
        json: true,
      });
      current = evaluate(state, rt, res.text);
      attempts.push({ kind: "rewrite_repair", draft: current.draft ?? current.text, violations: current.violations, usage: res.usage });
    }
    repairs++;
  }

  const baseRecord = {
    turn: state.turn + 1,
    kind,
    input,
    ...(fate !== undefined ? { fate } : {}),
    due: due.map((d) => d.id),
    attempts,
    context_parts: ctx.parts,
    at: new Date().toISOString(),
    ...(interlude ? { interlude } : {}),
  };

  if (current.violations.length > 0 || !current.draft) {
    const record: TurnRecord = {
      ...baseRecord,
      narration: null,
      beat: null,
      delta: [],
      outcome: "rolled_back",
      usage: usages,
    };
    await rt.store.commitTurn({ save_id: saveId, expected_turn: state.turn, state, record });
    return {
      turn: state.turn,
      kind,
      narration: config.gm_style.rollback_note,
      ...view(rt, state),
      outcome: "rolled_back",
      ...(interlude ? { interlude } : {}),
      record,
    };
  }

  let next = applyDraft(state, config, modules, current.draft, { input, due });

  if (shouldCompact(next)) {
    try {
      const req = buildCompactionRequest({ config, state: next, modules });
      const res = await call({ tier: "cheap", purpose: "compaction", system: req.system, messages: req.messages, max_tokens: 900, json: true });
      const parsed = parseCompactionResult(res.text);
      if (parsed.ok) next = applyCompaction(next, parsed.value, config);
    } catch {
      // Compaction is best-effort; the next turn retries.
    }
  }

  const elapsed = diffMinutes(next.clock.now, state.clock.now);
  if (config.offscreen?.enabled && elapsed >= config.offscreen.min_skip_hours * 60) {
    try {
      const sim = await runOffscreen({ config, state: next, modules, llm: rt.llm, elapsedMinutes: elapsed });
      usages.push(...sim.usage);
      next = sim.state;
    } catch {
      // Simulator is optional and never blocks the turn.
    }
  }

  const record: TurnRecord = {
    ...baseRecord,
    narration: current.draft.narration,
    beat: current.draft.beat,
    delta: current.draft.delta,
    outcome: rewrote ? "rewritten" : repairs > 0 ? "repaired" : "ok",
    usage: usages,
  };
  await rt.store.commitTurn({ save_id: saveId, expected_turn: state.turn, state: next, record });

  return {
    turn: next.turn,
    kind,
    narration: current.draft.narration,
    ...view(rt, next),
    outcome: record.outcome,
    ...(interlude ? { interlude } : {}),
    record,
  };
}
