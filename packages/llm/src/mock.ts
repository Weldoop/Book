import { estimateTokens } from "@book/schema";
import type { LLMProvider, LLMRequest, LLMResponse, LLMTier } from "@book/schema";
import { computeCost, DEFAULT_PRICES } from "./pricing.ts";
import type { Price } from "./pricing.ts";

export type FaultKind = "fixable" | "game_breaking" | "unparseable";

export interface MockProviderOptions {
  faults?: { every?: number; kind: FaultKind };
  /** Return a string to override the reply for this call; undefined falls back to default behaviour. */
  script?: (req: LLMRequest, callIndex: number) => string | undefined;
  latencyMs?: number;
  prices?: Record<LLMTier, Price>;
}

function words(text: string, n: number): string {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

function lastUserMessage(req: LLMRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}

/** The context builder may wrap the player's text; pick it out when it is labelled, else use the message start. */
function playerText(content: string): string {
  const section = /## PLAYER INPUT\s*\n([\s\S]*)$/i.exec(content);
  if (section?.[1]) return section[1].trim();
  const labelled = /^\s*(?:player input|player|input)\s*:\s*(.+)$/im.exec(content);
  return labelled?.[1] ?? content;
}

const DEST_STOP = "and|then|if|but|so|while|when|please|for|as|again|to";
const DEST = `(?:the\\s+|a\\s+|an\\s+)?([a-z][a-z']*(?:\\s+(?!${DEST_STOP}\\b)[a-z][a-z']*){0,5})`;

const TRIP = new RegExp(
  `\\b(?:walk|head|go|travel|ride|drive|hurry|set off)\\b[^.]{0,40}?\\b(?:to|towards|toward|into)\\s+${DEST}`,
  "gi",
);

const LEAVE_TRIP = new RegExp(`\\b(?:leave|left)\\s+(?:to|towards|toward|into)\\s+${DEST}`, "gi");

const PURPOSE = new Set([
  "ask",
  "buy",
  "call",
  "charge",
  "check",
  "find",
  "get",
  "grab",
  "look",
  "meet",
  "pick",
  "read",
  "say",
  "see",
  "tell",
  "text",
  "watch",
  "sleep",
  "rest",
  "nap",
]);

function tripDestination(input: string): string | null {
  const hits: { index: number; dest: string }[] = [];
  const take = (raw: string, index: number) => {
    const cut = raw.split(/\b(?:again|and|then|if|but|so|while|when|please|for|as)\b|\bto\b/)[0] ?? "";
    const dest = cut
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:the|a|an)\s+/, "");
    const first = dest.split(" ")[0] ?? "";
    if (dest.length >= 3 && !PURPOSE.has(first)) hits.push({ index, dest });
  };
  const source = input.toLowerCase();
  for (const match of source.matchAll(new RegExp(TRIP.source, "gi"))) take(match[1] ?? "", match.index ?? 0);
  for (const match of source.matchAll(new RegExp(LEAVE_TRIP.source, "gi"))) take(match[1] ?? "", match.index ?? 0);
  hits.sort((a, b) => a.index - b.index);
  return hits.at(-1)?.dest ?? null;
}

/** A currency stat named in the prompt. Falls back to money for books that still use one pot. */
function breakingStat(req: LLMRequest): string {
  const blob = req.messages.map((message) => message.content).join("\n");
  return /\[(cash|bank|money|gold)\]/.exec(blob)?.[1] ?? "money";
}

function playerId(req: LLMRequest): string {
  const blob = req.system.map((block) => block.text).join("\n");
  return /player character id is "([^"]+)"/.exec(blob)?.[1] ?? "player";
}

/** A world-sheet place whose name or id matches where the player asked to go. */
function placeForDestination(content: string, dest: string): { id: string; name: string } | null {
  const sheet = /## WORLD SHEET\n([\s\S]*?)(?:\n## |$)/.exec(content)?.[1] ?? "";
  const places = sheet.split(/^Places:\s*$/m)[1] ?? "";
  const needle = dest.toLowerCase();
  let best: { id: string; name: string; score: number } | null = null;
  for (const line of places.split("\n")) {
    const match = /^- ([a-z0-9-]+): (.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const name = match[2].replace(/\s*\(not yet visited\)\s*$/, "");
    const id = match[1];
    const hay = `${name} ${id.replace(/-/g, " ")}`.toLowerCase();
    const hit = hay === needle || new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay);
    if (!hit) continue;
    const score = name.length;
    if (!best || score < best.score) best = { id, name, score };
  }
  return best ? { id: best.id, name: best.name } : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestTokens(req: LLMRequest): { total: number; cacheable: number } {
  let cacheable = 0;
  let total = 0;
  for (const b of req.system) {
    const t = estimateTokens(b.text);
    total += t;
    if (b.cache) cacheable += t;
  }
  for (const m of req.messages) total += estimateTokens(m.content);
  return { total, cacheable };
}

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private readonly opts: MockProviderOptions;
  private callIndex = 0;
  private turnCallIndex = 0;
  private readonly prices: Record<LLMTier, Price>;

  constructor(opts: MockProviderOptions = {}) {
    this.opts = opts;
    this.prices = opts.prices ?? DEFAULT_PRICES;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const started = performance.now();
    const index = this.callIndex++;
    const isFirst = index === 0;
    if (this.opts.latencyMs && this.opts.latencyMs > 0) await sleep(this.opts.latencyMs);

    const fault = this.activeFault(req);
    const scripted = this.opts.script?.(req, index);
    const text = scripted !== undefined ? scripted : this.reply(req, fault);

    const { total, cacheable } = requestTokens(req);
    const output = estimateTokens(text);
    const cached = isFirst ? 0 : cacheable;
    return {
      text,
      usage: {
        model: `mock-${req.tier}`,
        input_tokens: total,
        output_tokens: output,
        cached_input_tokens: cached,
        cost_usd: computeCost(this.prices[req.tier], total, output, cached),
        latency_ms: Math.max(0, Math.round(performance.now() - started)),
        purpose: req.purpose,
      },
    };
  }

  private activeFault(req: LLMRequest): FaultKind | undefined {
    if (req.purpose !== "turn") return undefined;
    this.turnCallIndex++;
    const f = this.opts.faults;
    if (!f) return undefined;
    const every = f.every ?? 1;
    return every > 0 && this.turnCallIndex % every === 0 ? f.kind : undefined;
  }

  private reply(req: LLMRequest, fault: FaultKind | undefined): string {
    switch (req.purpose) {
      case "delta_repair":
        return JSON.stringify({ delta: [{ op: "clock.advance", minutes: 5 }], beat: "Mock repaired the bookkeeping." });
      case "ooc": {
        const q = words(playerText(lastUserMessage(req)).replace(/^\s*OOC:\s*/i, ""), 12);
        return `[Out of character: you asked "${q}". The mock game master has nothing further to add.]`;
      }
      case "compaction":
        return JSON.stringify({
          chapter_summary: "Mock chapter summary of recent events.",
          story_so_far: "Mock story so far.",
          facts: [],
          resolve_threads: [],
        });
      case "baseline_turn": {
        const echo = words(playerText(lastUserMessage(req)), 12);
        return `You ${echo}. The scene moves on around you, and the day goes quietly on while you decide what to do next.\n\nmoney | health | place | time`;
      }
      case "rewrite_repair":
        return this.turnJson(req, undefined);
      case "turn":
        return this.turnJson(req, fault);
      case "opening":
        return JSON.stringify({
          narration: "The day starts quietly, before anyone has decided what it is for.",
          delta: [
            {
              op: "entity.create",
              id: "rowan-hale",
              type: "person",
              name: "Rowan Hale",
              tags: ["unmet"],
              facts: ["Keeps odd hours and is not in the room."],
            },
            {
              op: "entity.create",
              id: "sam-okonkwo",
              type: "person",
              name: "Sam Okonkwo",
              tags: ["unmet"],
              facts: ["Works a late shift."],
            },
            {
              op: "entity.create",
              id: "priya-shah",
              type: "person",
              name: "Priya Shah",
              tags: ["unmet"],
              facts: ["Leaves the house early."],
            },
            {
              op: "thread.open",
              kind: "commitment",
              text: "Rowan Hale left a note asking you to cover something before the week turns.",
              due: "2099-06-01T18:00",
              entities: ["rowan-hale"],
            },
            { op: "clock.advance", minutes: 1 },
          ],
          beat: "A new chapter of the life begins.",
        });
      default:
        return this.turnJson(req, undefined);
    }
  }

  private turnJson(req: LLMRequest, fault: FaultKind | undefined): string {
    const content = lastUserMessage(req);
    const echo = words(playerText(content), 12);
    const narration = `You ${echo}. The moment passes and the world shifts a little around you.`;
    const beat = `Player: ${words(echo, 8)}.`;
    if (fault === "unparseable") return `${narration} (the storyteller forgot to use JSON here)`;
    const dest = fault ? null : tripDestination(playerText(content));
    const place = dest ? placeForDestination(content, dest) : null;
    let delta: unknown[] = [{ op: "clock.advance", minutes: 10 }];
    if (place) {
      delta = [
        { op: "entity.move", id: playerId(req), location: place.id },
        { op: "clock.advance", minutes: 10 },
      ];
    }
    if (fault === "fixable") delta = [{ op: "clock.advance", minutes: "ten" }];
    if (fault === "game_breaking") delta = [{ op: "stat.add", key: breakingStat(req), amount: -1000000, reason: "mock fault" }];
    return JSON.stringify({ narration, delta, beat, ...(place ? { at: place.id } : {}) });
  }
}
