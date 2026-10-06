export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["delta-first", "debug", "log-raw", "help"]);

/** `--key value`, `--key=value` and bare boolean flags. The first non-flag token is the command. */
export function parseFlags(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") || arg.length === 2) {
      rest.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (BOOLEAN_FLAGS.has(body) || next === undefined || next.startsWith("--")) {
      flags[body] = true;
    } else {
      flags[body] = next;
      i++;
    }
  }
  const [command, ...positionals] = rest;
  return { command, positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === true) throw new Error(`--${name} needs a value`);
  return v;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number, got "${raw}"`);
  return n;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const v = args.flags[name];
  return v === true || v === "true";
}

export interface FaultSpec {
  every?: number;
  kind: "fixable" | "game_breaking" | "unparseable";
}

/** Parses `every=7,kind=game_breaking`. */
export function parseFaults(spec: string): FaultSpec {
  const out: { every?: number; kind?: string } = {};
  for (const part of spec.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (k === "every" && v) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--faults every must be a positive integer, got "${v}"`);
      out.every = n;
    } else if (k === "kind" && v) {
      out.kind = v;
    } else {
      throw new Error(`Bad --faults entry "${part}". Expected every=N,kind=fixable|game_breaking|unparseable`);
    }
  }
  if (out.kind !== "fixable" && out.kind !== "game_breaking" && out.kind !== "unparseable") {
    throw new Error("--faults needs kind=fixable|game_breaking|unparseable");
  }
  return out.every === undefined ? { kind: out.kind } : { every: out.every, kind: out.kind };
}
