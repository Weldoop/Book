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
  const labelled = /^\s*(?:player input|player|input)\s*:\s*(.+)$/im.exec(content);
  return labelled?.[1] ?? content;
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
    const echo = words(playerText(lastUserMessage(req)), 12);
    const narration = `You ${echo}. The moment passes and the world shifts a little around you.`;
    const beat = `Player: ${words(echo, 8)}.`;
    if (fault === "unparseable") return `${narration} (the storyteller forgot to use JSON here)`;
    let delta: unknown[] = [{ op: "clock.advance", minutes: 10 }];
    if (fault === "fixable") delta = [{ op: "clock.advance", minutes: "ten" }];
    if (fault === "game_breaking") delta = [{ op: "stat.add", key: "money", amount: -1000000, reason: "mock fault" }];
    return JSON.stringify({ narration, delta, beat });
  }
}
