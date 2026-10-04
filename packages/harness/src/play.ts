import type { Config, LLMUsage, Store, LLMProvider } from "@book/schema";
import type { RuntimeApi, TurnResultLike } from "./runtime-api.ts";

export interface PlayIO {
  /** Resolves null at end of input. */
  readLine(prompt: string): Promise<string | null>;
  write(text: string): void;
  color?: boolean;
}

export interface PlayOptions {
  api: RuntimeApi;
  config: Config;
  store: Store;
  llm: LLMProvider;
  saveId: string;
  deltaFirst?: boolean;
  logRaw?: boolean;
  io: PlayIO;
  debug?: boolean;
  /** Returns a reason when a spend cap is used up, so play stops between turns instead of mid-turn. */
  stopCheck?: () => string | undefined;
}

export function rollLine(result: TurnResultLike): string | null {
  const r = result.roll;
  if (!r) return null;
  const stat = r.stat ? `, ${r.stat}` : "";
  return `Fate ${r.value} - ${r.band} (${r.what}${stat})`;
}

/** One quiet line when the turn did not come back clean, so a stutter can be reported without running inspect. */
export function stutterLine(result: TurnResultLike): string | null {
  const kinds = result.record.attempts.slice(1).map((a) => a.kind);
  const how = kinds.length ? `: ${kinds.join(", ")}` : "";
  switch (result.outcome) {
    case "ok":
      return null;
    case "repaired":
      return `[turn ${result.turn} needed a repair${how}]`;
    case "rewritten":
      return `[turn ${result.turn} was rewritten${how}]`;
    default:
      return `[turn did not commit and was rolled back${how}]`;
  }
}

export function usageLine(result: TurnResultLike, wallMs: number): string {
  const u: LLMUsage[] = result.record.usage;
  const sum = (pick: (x: LLMUsage) => number): number => u.reduce((n, x) => n + pick(x), 0);
  const secs = (wallMs / 1000).toFixed(1);
  return `in ${sum((x) => x.input_tokens)}  out ${sum((x) => x.output_tokens)}  cached ${sum((x) => x.cached_input_tokens)}  $${sum((x) => x.cost_usd).toFixed(4)}  ${secs}s  ${result.outcome}`;
}

export function debugDump(result: TurnResultLike): string {
  const r = result.record;
  const lines = [`turn ${r.turn} (${r.kind}) outcome ${r.outcome}`, "context parts:"];
  for (const p of r.context_parts) lines.push(`  ${p.name.padEnd(20)} ${String(p.tokens).padStart(5)}${p.trimmed ? "  (trimmed)" : ""}`);
  lines.push(`attempts: ${r.attempts.length}`);
  r.attempts.forEach((a, i) => {
    lines.push(`  ${i + 1}. ${a.kind}: ${a.violations.length} violation(s)`);
    for (const v of a.violations) lines.push(`     [${v.severity}] ${v.code}: ${v.message}`);
  });
  return lines.join("\n");
}

export async function runPlay(opts: PlayOptions): Promise<void> {
  const { io } = opts;
  const dim = (s: string): string => (io.color ? `\x1b[2m${s}\x1b[0m` : s);
  const rt = opts.api.createRuntime({
    config: opts.config,
    store: opts.store,
    llm: opts.llm,
    ...(opts.deltaFirst ? { deltaFirst: true } : {}),
    ...(opts.logRaw ? { logRaw: true } : {}),
  });

  const existing = (await opts.store.listSaves()).some((s) => s.save_id === opts.saveId);
  if (existing) {
    const state = await opts.store.loadSave(opts.saveId);
    io.write(dim(`Resumed "${opts.saveId}" at turn ${state.turn}.`) + "\n");
  } else {
    await opts.api.newGame(rt, opts.saveId);
    io.write(dim(`New game "${opts.saveId}": ${opts.config.meta.title}. Type your first action (for example "Start the game").`) + "\n");
  }
  io.write(dim("One line = one turn (several actions in one line are fine). End a line with \\ to continue it on the next line. /quit to exit, /debug for the debug dump.") + "\n");

  let debug = opts.debug ?? false;
  let last: TurnResultLike | undefined;

  for (;;) {
    let line = await io.readLine("\n> ");
    if (line === null) break;
    while (line.trimEnd().endsWith("\\")) {
      const more = await io.readLine("... ");
      if (more === null) break;
      line = `${line.trimEnd().slice(0, -1).trimEnd()}\n${more}`;
    }
    const text = line.trim();
    if (text === "/quit" || text === "/exit") break;
    if (text === "/debug") {
      debug = !debug;
      io.write(dim(`debug ${debug ? "on" : "off"}`) + "\n");
      if (debug && last) io.write(dim(debugDump(last)) + "\n");
      continue;
    }

    const stop = opts.stopCheck?.();
    if (stop) {
      io.write(dim(`Stopping: ${stop}. Your save is intact; raise the cap and resume with the same --save.`) + "\n");
      break;
    }

    const t0 = performance.now();
    let result: TurnResultLike;
    try {
      result = await opts.api.playTurn(rt, opts.saveId, text, {
        onInterlude: (t) => io.write(`\n${dim(t)}\n`),
      });
    } catch (err) {
      io.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
      break;
    }
    last = result;
    const roll = rollLine(result);
    if (roll) io.write(`\n${roll}\n`);
    io.write(`\n${result.narration}\n`);
    if (result.status) io.write(`\n${result.status}\n`);
    if (opts.config.presentation.profile === "tabletop" && result.panel.length > 0) {
      io.write(result.panel.map((p) => `  ${p}`).join("\n") + "\n");
    }
    const stutter = stutterLine(result);
    if (stutter) io.write(dim(stutter) + "\n");
    io.write(dim(`[${usageLine(result, performance.now() - t0)}]`) + "\n");
    if (debug) io.write(dim(debugDump(result)) + "\n");
  }
}
