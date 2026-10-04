import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ConfigSchema } from "@book/schema";
import type { Config, Store } from "@book/schema";
import { FileStore } from "@book/store";
import { runBaseline } from "./baseline.ts";
import { parseFixture, parseProbes } from "./fixture.ts";
import type { Fixture, Probe } from "./fixture.ts";
import { flagBool, flagString, parseFlags } from "./flags.ts";
import type { ParsedArgs } from "./flags.ts";
import { runPlay } from "./play.ts";
import type { PlayIO } from "./play.ts";
import { setupProvider } from "./provider-setup.ts";
import { compareReports, formatComparison, formatReport, parseReport } from "./report.ts";
import type { Report } from "./report.ts";
import { runReplay } from "./replay.ts";
import { loadRuntimeApi } from "./runtime-api.ts";
import type { RuntimeApi } from "./runtime-api.ts";

export const USAGE = `Usage: pnpm book <command> [flags]

  play      --config <path> [--save name] [--provider mock|anthropic] [--delta-first]
  replay    --config <path> --fixture <path> [--probes <path>] [--provider mock|anthropic]
            [--max-turns N] [--max-cost-usd X] [--max-total-tokens N]
            [--faults every=7,kind=game_breaking] [--save name] [--out <dir>]
  baseline  --config <path> --fixture <path> [same flags as replay]
  report    <report.json> [<other.json>]

Real-model runs need --provider anthropic, ANTHROPIC_API_KEY in the environment,
and at least one of --max-cost-usd, --max-total-tokens, --max-turns.`;

export interface CliDeps {
  env?: Record<string, string | undefined>;
  loadRuntime?: () => Promise<RuntimeApi>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Root directory for saves and reports. Defaults to `.book-data` under cwd. */
  dataRoot?: string;
  makePlayIO?: () => PlayIO & { close(): void };
  now?: () => Date;
  makeStore?: (root: string) => Store;
}

function required(args: ParsedArgs, name: string): string {
  const v = flagString(args, name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Cannot read ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

async function loadConfig(path: string): Promise<Config> {
  const r = ConfigSchema.safeParse(await readJson(path));
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`${path} is not a valid config: ${i?.path.join(".") ?? ""} ${i?.message ?? ""}`);
  }
  return r.data;
}

async function loadInputs(args: ParsedArgs): Promise<{ config: Config; fixture: Fixture; probes: Probe[] }> {
  const config = await loadConfig(required(args, "config"));
  const fixturePath = required(args, "fixture");
  const fixture = parseFixture(await readJson(fixturePath), fixturePath);
  const probesPath = flagString(args, "probes");
  const probes = probesPath ? parseProbes(await readJson(probesPath), probesPath) : [];
  return { config, fixture, probes };
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

async function writeReport(dir: string, name: string, report: Report): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  return path;
}

function defaultPlayIO(): PlayIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  return {
    color: Boolean(process.stdout.isTTY),
    write: (t) => process.stdout.write(t),
    readLine: (prompt) =>
      closed ? Promise.resolve(null) : new Promise((resolve) => {
        const onClose = (): void => resolve(null);
        rl.once("close", onClose);
        rl.question(prompt, (a) => {
          rl.off("close", onClose);
          resolve(a);
        });
      }),
    close: () => rl.close(),
  };
}

/** Returns a process exit code. */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => process.stdout.write(`${t}\n`));
  const errOut = deps.err ?? ((t: string) => process.stderr.write(`${t}\n`));
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const dataRoot = deps.dataRoot ?? join(process.cwd(), ".book-data");
  const args = parseFlags(argv);

  try {
    switch (args.command) {
      case "play": {
        const config = await loadConfig(required(args, "config"));
        const setup = setupProvider(args, env);
        const api = await (deps.loadRuntime ?? loadRuntimeApi)();
        const store = (deps.makeStore ?? ((r) => new FileStore(r)))(dataRoot);
        const io = (deps.makePlayIO ?? defaultPlayIO)();
        try {
          await runPlay({
            api,
            config,
            store,
            llm: setup.llm,
            saveId: flagString(args, "save") ?? `play-${config.id}`,
            deltaFirst: flagBool(args, "delta-first"),
            io,
            debug: flagBool(args, "debug"),
          });
        } finally {
          io.close();
        }
        return 0;
      }
      case "replay":
      case "baseline": {
        const { config, fixture, probes } = await loadInputs(args);
        const setup = setupProvider(args, env);
        const outDir = flagString(args, "out") ?? join(dataRoot, "reports");
        const common = {
          config,
          fixture,
          probes,
          llm: setup.llm,
          providerName: setup.name,
          stopCheck: () => setup.stopCheck(),
          onLine: out,
          now,
          ...(setup.caps.maxTurns !== undefined ? { maxTurns: setup.caps.maxTurns } : {}),
        };
        let report: Report;
        if (args.command === "replay") {
          const api = await (deps.loadRuntime ?? loadRuntimeApi)();
          const store = (deps.makeStore ?? ((r) => new FileStore(r)))(dataRoot);
          const saveId = flagString(args, "save") ?? `replay-${fixture.id}-${setup.name}-${stamp(now())}`;
          report = await runReplay({ ...common, api, store, saveId, deltaFirst: flagBool(args, "delta-first") });
        } else {
          report = await runBaseline(common);
        }
        const path = await writeReport(outDir, `${args.command}-${fixture.id}-${setup.name}.json`, report);
        out("");
        out(formatReport(report));
        out(`report written to ${path}`);
        return 0;
      }
      case "report": {
        const [p1, p2] = args.positionals;
        if (!p1) throw new Error("report needs a report file: pnpm book report <report.json> [<other.json>]");
        const first = parseReport(await readJson(p1), p1);
        if (!p2) {
          out(formatReport(first));
          return 0;
        }
        const second = parseReport(await readJson(p2), p2);
        const [a, b] = first.kind === "engine" && second.kind === "baseline" ? [second, first] : [first, second];
        out(formatComparison(compareReports(a, b)));
        return 0;
      }
      case undefined:
      case "help":
        out(USAGE);
        return args.command === undefined ? 1 : 0;
      default:
        errOut(`Unknown command "${args.command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    errOut(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
