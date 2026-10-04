import {
  applyDraft,
  classifyInput,
  collectDue,
  createInitialState,
  diffMinutes,
  pickInterlude,
  rollFate,
  severityOf,
  openScene,
  stripOocPrefix,
  playerNotices,
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
import {
  applyContinuation,
  continuationDue,
  endingById,
  fateLabel,
  getActiveModules,
  markEnding,
  pickEnding,
  renderView,
} from "@book/modules";
import type {
  Attempt,
  Config,
  DueItem,
  Ending,
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
  /** Keep every model reply verbatim in the turn log. Off by default; on while testing. */
  logRaw: boolean;
}

export interface TurnResult {
  turn: number;
  kind: TurnKind;
  narration: string;
  status: string | null;
  panel: string[];
  outcome: TurnRecord["outcome"];
  interlude?: string;
  /** Set on the turn an ending fires, and on any input after a final ending. */
  ending?: { id: string; title: string; text: string; continuation?: string };
  /** Set on the turn the GM closed a scene, so the UI can offer the way on rather than guessing. */
  scene_ended?: boolean;
  /** Set when the GM resolved the action with the die and the config shows rolls to the player. */
  roll?: { value: number; band: string; what: string; stat?: string };
  /** Engine-printed warnings (low money, a broken promise). The narration may also mention them. */
  notices: string[];
  record: TurnRecord;
}

export interface TurnHooks {
  onInterlude?(text: string): void;
  /** Fired with the validated turn before the archivist runs, so the player can read while memory is written. */
  onReleased?(result: TurnResult): void;
}

const COMPACTION_HOLD_TURNS = 5;
const COMPACTION_MAX_TOKENS = 1600;

function holdCompaction(state: State): State {
  return {
    ...state,
    summaries: { ...state.summaries, compaction_hold_until: state.turn + COMPACTION_HOLD_TURNS },
  };
}

export function createRuntime(opts: {
  config: Config;
  store: Store;
  llm: LLMProvider;
  modules?: Module[];
  outputOrder?: "narration_first" | "delta_first";
  deltaFirst?: boolean;
  logRaw?: boolean;
}): Runtime {
  return {
    config: opts.config,
    store: opts.store,
    llm: opts.llm,
    modules: opts.modules ?? getActiveModules(opts.config),
    outputOrder: opts.outputOrder ?? (opts.deltaFirst ? "delta_first" : "narration_first"),
    logRaw: opts.logRaw ?? false,
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

function evaluate(state: State, rt: Runtime, text: string, input = ""): Evaluated {
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
  const result = validateDraft(state, rt.config, rt.modules, parsed.draft, input);
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
  return { turn: state.turn, kind: "ooc", narration: record.narration ?? "", ...view(rt, state), outcome: "ok", notices: [], record };
}

/** Any input after a final ending. No model call: the story is over and the save stays closed. */
async function replayEnding(rt: Runtime, state: State, rawInput: string, ending: Ending): Promise<TurnResult> {
  const record: TurnRecord = {
    turn: state.turn,
    kind: "act",
    input: rawInput,
    narration: ending.text,
    beat: null,
    delta: [],
    due: [],
    attempts: [],
    outcome: "ended",
    context_parts: [],
    usage: [],
    at: new Date().toISOString(),
  };
  await rt.store.appendLog(state.save_id, { type: "ended", record });
  return {
    turn: state.turn,
    kind: "act",
    narration: ending.text,
    ...view(rt, state),
    outcome: "ended",
    ending: { id: ending.id, title: ending.title, text: ending.text },
    notices: [],
    record,
  };
}

export async function playTurn(rt: Runtime, saveId: string, rawInput: string, hooks: TurnHooks = {}): Promise<TurnResult> {
  let state = await rt.store.loadSave(saveId);
  const kind = classifyInput(rawInput);
  if (kind === "ooc") return playOoc(rt, state, rawInput);

  const { config, modules } = rt;
  const input = kind === "continue" ? "..." : rawInput.trim();

  // The GM closed the last scene, so the player is acting in a new one.
  state = openScene(state);

  // A pending ending is resolved before anything else: either the story carries on from the
  // situation the config describes, or it is final and this input cannot move it.
  const carryOn: DueItem[] = [];
  if (state.ending) {
    const fired = endingById(config, state.ending.id);
    if (fired && state.ending.continuable) {
      state = applyContinuation(state, config, fired);
      await rt.store.updateState(saveId, state, state.turn);
      carryOn.push(continuationDue(fired));
    } else if (fired) {
      return replayEnding(rt, state, rawInput, fired);
    }
  }

  const fate = rollFate(state, config);
  const due = [...carryOn, ...collectDue(state, config, modules)];
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
  const rawOf = (text: string) => (rt.logRaw ? { raw: text } : {});
  let current = evaluate(state, rt, first.text, input);
  attempts.push({ kind: "draft", draft: current.draft ?? current.text, ...rawOf(first.text), violations: current.violations, usage: first.usage });

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
      current = evaluate(state, rt, res.text, input);
      attempts.push({ kind: "format_repair", draft: current.draft ?? current.text, ...rawOf(res.text), violations: current.violations, usage: res.usage });
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
        const result = validateDraft(state, config, modules, candidate, input);
        current = { draft: candidate, text: JSON.stringify(candidate), violations: result.violations };
      } else {
        current = {
          draft: current.draft,
          text: current.text,
          violations: [{ severity: "fixable", code: "repair_unreadable", message: `The delta repair could not be read (${fixed.error}).` }],
        };
      }
      attempts.push({ kind: "delta_repair", draft: current.draft ?? current.text, ...rawOf(res.text), violations: current.violations, usage: res.usage });
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
      current = evaluate(state, rt, res.text, input);
      attempts.push({ kind: "rewrite_repair", draft: current.draft ?? current.text, ...rawOf(res.text), violations: current.violations, usage: res.usage });
    }
    repairs++;
  }

  const baseRecord = {
    turn: state.turn + 1,
    kind,
    input,
    ...(fate !== undefined ? { fate } : {}),
    due: due.map((d) => d.id),
    ...(ctx.threads_shown?.length ? { threads_shown: ctx.threads_shown } : {}),
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
      notices: [],
      record,
    };
  }

  let next = applyDraft(state, config, modules, current.draft, {
    input,
    due,
    shown_threads: ctx.threads_shown ?? [],
  });

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

  const fired = pickEnding(next, config);
  if (fired) next = markEnding(next, fired);

  const outcome = rewrote ? "rewritten" : repairs > 0 ? "repaired" : "ok";
  const check = current.draft.check;
  const partial: TurnRecord = {
    ...baseRecord,
    narration: current.draft.narration,
    beat: current.draft.beat,
    delta: current.draft.delta,
    ...(check ? { check } : {}),
    outcome,
    usage: [...usages],
  };
  const visible: TurnResult = {
    turn: next.turn,
    kind,
    narration: current.draft.narration,
    ...view(rt, next),
    outcome,
    notices: playerNotices(due),
    ...(interlude ? { interlude } : {}),
    ...(next.scene.closed ? { scene_ended: true } : {}),
    ...(fired
      ? {
          ending: {
            id: fired.id,
            title: fired.title,
            text: fired.text,
            ...(fired.continue ? { continuation: fired.continue.label } : {}),
          },
        }
      : {}),
    ...(check && fate !== undefined && config.dice?.visible
      ? {
          roll: {
            value: fate,
            band: fateLabel(config, fate),
            what: check.what,
            ...(check.stat ? { stat: check.stat } : {}),
          },
        }
      : {}),
    record: partial,
  };

  let hookError: unknown;
  try {
    hooks.onReleased?.(visible);
  } catch (err) {
    hookError = err;
  }

  if (shouldCompact(next, config)) {
    try {
      const req = buildCompactionRequest({ config, state: next, modules });
      const res = await call({
        tier: "cheap",
        purpose: "compaction",
        system: req.system,
        messages: req.messages,
        max_tokens: COMPACTION_MAX_TOKENS,
        json: true,
      });
      const parsed = parseCompactionResult(res.text);
      if (parsed.ok) next = applyCompaction(next, parsed.value, config);
      else next = holdCompaction(next);
    } catch {
      next = holdCompaction(next);
    }
  }

  const record: TurnRecord = { ...partial, usage: usages };
  await rt.store.commitTurn({ save_id: saveId, expected_turn: state.turn, state: next, record });
  const result: TurnResult = { ...visible, record };
  if (hookError) throw hookError;
  return result;
}
