# AI Story Engine: Architecture Plan (v2, proof of concept)

Status: draft for review. Supersedes the architecture sections of `ai-rpg-master-plan` (v1).
Working title: TBD. Last updated: 4 Oct 2026.

---

## 1. Purpose and thesis

Prove one thing before anything else:

> A long game (200+ turns, 30-60 minute sessions, resumable) can stay coherent and engaging while the context sent per turn stays small and flat.

Everything in the proof of concept (PoC) exists to test that thesis. Publishing, tips, billing, multiplayer and the wizard are designed for (see section 13) but not built.

### 1.1 Why a new architecture

Evidence from a real 121-turn session on a plain chat setup (figures are estimates):

| Observation | Implication |
|---|---|
| ~35k tokens of context at the end, resent every turn | Cumulative input is roughly quadratic in turns (~3M at 121 turns, ~29M at 500) |
| Status line (money, health, place, time) of 25-30 tokens on every reply | Deterministic output the engine should render, not the model |
| Player messages often contain 2-4 actions | Turn design must accept batched actions in one call |
| ~7% of turns were "..." (continue the scene) | Needs real generation; cannot be skipped by a router |
| A few turns were out-of-character questions | Cheap read-only path from stored state |
| A dozen or more dated commitments, favours and debts carried through the session | A structured threads list is far cheaper than re-reading history |
| Running jokes, owed favours and recurring side characters drive engagement | Compression must preserve them as structured callbacks |

### 1.2 Targets (to be validated, not assumed)

| Metric | Target |
|---|---|
| Input tokens per turn at turn 200 | under 5k, and flat from turn ~20 onward |
| Output tokens per turn | under 250 (narration plus structured delta) |
| Model calls per turn | 1 normally; at most 3 including repairs (plus a batched cheap call every ~20 turns) |
| Time until the player sees the story | under 10 seconds on a normal turn, under 20 seconds on a repaired turn |
| GM interlude rate (game-breaking drafts) | under 3% of turns |
| Recall probes (facts from turns 1-50 asked at turn 200) | at least 90% correct |
| Turns that fail all repairs and roll back | under 0.5% |
| Replay determinism | identical state from the delta log, 100% |

---

## 2. Scope

### In scope (PoC)
- Single player, text only.
- Universal engine built from composable modules, driven by a game config.
- One model call per turn returning narration and a structured state delta.
- Layered memory (recent window, beats, summaries, threads).
- Token metering and a debug view of the exact context sent each turn.
- Replay and benchmark harness (baseline full-history vs engine).
- Two hand-written configs: UK life sim first, Pirate Caribbean second.
- Presentation profiles (novel, light, tabletop) set by the config.
- Content rating field in the config.
- Storage behind an interface; local file implementation first.

### Out of scope (designed for, not built)
Hosted trial and billing, bring-your-own-key, publishing and discovery, stars, favourites, tips, creator payouts, the world wizard, multiplayer, voice, images, mobile PWA.

---

## 3. Design principles

1. **AI proposes, engine commits.** The model never writes state. It returns a delta; code validates and applies it.
2. **Code owns anything countable.** Clock, money, stats, inventory, dice, schedules and the status line are deterministic.
3. **One call per turn where possible.** Narration and delta come from the same call so the story and the state cannot drift apart. If validation fails, a repair call fixes it (section 5.3).
3a. **Validate before the player sees anything.** The player only ever sees narration that has passed validation and been committed. A broken draft is never shown.
4. **Bounded context.** Per-turn context has a hard token budget independent of game length or world size.
5. **Structure over transcript.** Facts, threads and callbacks live in structured state; prose history is only a recent window.
6. **Modules, not a mega-engine.** Every mechanic is an optional module with the same interface.
7. **Measure first.** Every turn logs tokens, cost, latency and validation outcomes. Decisions come from the benchmark.
8. **Robust to weak models.** Strict schemas, one repair retry, graceful fallback (narrate only, no state change).

---

## 4. High-level components

```
                +---------------------------+
 Player input ->|  Turn controller          |
                |  (classify: act / ooc /   |
                |   continue)               |
                +-----+---------------------+
                      |
          +-----------v-----------+      +----------------------+
          | Context builder       |<-----| State store          |
          | (budgeted, prioritised|      | (state, threads,     |
          |  assembly)            |      |  beats, summaries,   |
          +-----------+-----------+      |  delta log, usage)   |
                      |                  +----------^-----------+
          +-----------v-----------+                 |
          | LLM adapter           |                 |
          | (provider-agnostic,   |                 |
          |  usage metering)      |                 |
          +-----------+-----------+                 |
                      |  { narration, delta, beat } |
          +-----------v-----------+                 |
          | Validator + reducer   |-----------------+
          | (modules, schema,     |   commit (atomic)
          |  clock, rules)        |
          +-----------+-----------+
                      |
          +-----------v-----------+
          | Renderer              |
          | narration + engine-   |
          | built status/stat view|
          +-----------------------+

 Background (every ~20 turns, cheap model, batched):
   compaction: beats -> chapter summary, fact consolidation, thread cleanup
```

### 4.1 Roles in the game (components, not separate AI agents)

The game has several roles, but only some of them are model calls. A role that is a model call re-sends context and adds cost and latency, so a role is code unless it needs language understanding.

| Role | Implemented as | Tokens |
|---|---|---|
| World keeper (stats, money, inventory, clock, schedules, database) | Code and the store; updates only when a validated delta arrives | none |
| Validator | Code: schema, module rules, bounds, permissions | none |
| Attention mapper (decides what the storyteller sees) | Code in the context builder (section 6.1) | none |
| Storyteller | The single strong-model call per turn | main cost |
| Archivist (summaries, fact consolidation) | Cheap-model call, batched every ~20 turns | small |
| Out-of-character helper | Cheap-model call, read-only | small |
| World simulator (off-screen NPC activity during long time skips) | Optional per-game module `offscreen`; cheap-model call only on large time jumps (section 9.6) | small, rare, off by default |

An LLM validator is not part of the default design. It is only considered later as an occasional consistency check if code validation proves too weak, because it would add a second call to every turn.

The storyteller does not hold the game state. It is shown the relevant slice each turn and returns proposed changes; the world keeper owns the truth. Deterministic changes can also be resolved by code before the call (for example a purchase at a config-defined price), so the model narrates the result instead of working out the arithmetic.

---

## 5. Turn pipeline

### 5.1 Turn types (decided by code, no model call)

| Type | Detection | Path |
|---|---|---|
| `ooc` | prefix `OOC:` / parenthesised / config alias like "DM" | Read-only call to the cheap tier with the state snapshot only; no delta applied |
| `continue` | "..." or empty | Same as `act`, with the engine supplying the next due scheduled event or a pacing hint |
| `act` | everything else | Full pipeline; may contain several actions |

Trivial deterministic actions (for example "wait until 14:00") may later be resolved by code with a template. Not in PoC.

### 5.2 Steps for `act` and `continue`

1. **Pre-roll.** Engine draws one "fate die" for the turn (if the dice module is on) and records it. The model uses it when a risky action needs a result, so outcomes are not invented by the model.
2. **Due events.** Engine checks the clock, scheduled events, conditional triggers and random tables, and lists anything that fires this turn.
3. **Build context** (section 6).
4. **One model call** returning strict JSON: `{ narration, delta, beat, suggestions? }`.
5. **Validate** the draft (schema, module rules, permission, clock bounds, state contradictions). The narration is held back until validation passes. While waiting, the UI shows a "storyteller is writing" indicator. On failure, run the repair flow (section 5.3).
6. **Commit** state, delta, beat and usage atomically (single transaction on database stores; single write on file store). The commit includes only the approved narration.
7. **Release and render** the approved narration plus the status line or stat panel built from config presentation settings. The model never writes the status line.

### 5.3 Validate-then-release and the repair flow

Rule: nothing reaches the player until it has passed validation and been committed to the database. The player never sees a rejected draft, an error message, or a half-applied turn.

**Failure severity** (decided by the validator, in code):

| Severity | Meaning | Examples | Repair |
|---|---|---|---|
| `fixable` | The narration is fine; the bookkeeping is wrong | Malformed op, unknown field, rounding, missing `beat`, wrong entity id spelling | Delta-only repair. Silent; the player just sees the normal "writing" indicator for a little longer |
| `game_breaking` | The narration contradicts the rules or state | Spends money the player does not have, uses an item not owned, moves somewhere unreachable, time jump beyond bounds, acts through a dead or absent character, invents an entity without declaring it | Narration and delta are both rewritten, with a GM interlude (below) |

**Flow**

1. Draft arrives (`narration`, `delta`, `beat`). It is held back and not stored in the visible transcript.
2. Validator runs. If it passes: commit, then release the narration (section 5.2).
3. If `fixable`: small **delta repair** call. Input is only the draft narration, the rejected ops with errors, and the relevant state slice. Output is a corrected delta. Re-validate; on pass, commit and release the original narration.
4. If `game_breaking`: the engine shows the player a **GM interlude** (below), then makes a **rewrite repair** call. Input is the original player input, the rejected draft, the specific rule violations in plain language, and the relevant state slice. Output is a new `narration`, `delta` and `beat` that respect the rules. Re-validate; on pass, commit and release the corrected narration.
5. If the rewrite also fails, make one more attempt on the strong tier. If that fails too, the turn is rolled back: no state change, no draft shown, and the engine shows an in-world GM note asking the player to rephrase or try a different approach. The turn counter does not advance.
6. Maximum two repair calls per turn. Cost is capped per turn.

**Logging (as normal)**
- The delta log records every attempt: original draft, violations, repair calls, final result and tokens, marked `source: repair`.
- Rejected narration is stored in the log only. It never enters the recent-turns window, the beats, the summaries or the transcript, so the model never sees its own broken version as history.
- The debug panel shows the violations, the repair path taken and the cost.

**GM interlude (game-breaking only)**
- A short in-world line written by the engine from templates in the config, so it costs no tokens. Example for the UK sim: *"The moment wobbles and slips out of focus... the Game Master rewinds a few seconds and tries again."* Example for the pirate sim: *"The tide turns against the tale... the Game Master redraws the chart."*
- Templates live in `gm_style.interludes` (section 9.1) and are chosen at random so they do not repeat every time.
- The interlude is shown while the rewrite is running, then replaced by or followed by the corrected narration. Only the corrected story is saved as the turn.
- Interludes are logged and counted. If they are frequent they hurt immersion, so the benchmark reports the interlude rate against a target of under 3% of turns.

**Escalation if repairs are frequent:** tighten the op schema and prompt, then use the stronger tier for the turn call, then consider asking for the delta before the narration in the output (below), and only then consider a standing two-call pipeline (decide, then write).

**Streaming note.** Because narration is held until validation, there is no word-by-word streaming of unvalidated text. Option to test: order the model output as delta first, then narration. The delta can be validated while the narration is still being generated, and the narration is released the moment the delta commits. This keeps perceived speed close to normal streaming.

### 5.4 Model output contract (draft)

```json
{
  "narration": "string, within gm_style limits",
  "delta": [
    { "op": "clock.advance", "minutes": 20 },
    { "op": "stat.add", "key": "money", "amount": -4.2, "reason": "cafe" },
    { "op": "entity.fact.add", "id": "glenys", "fact": "Lent mower; wants it back by 4pm", "importance": 2 },
    { "op": "thread.open", "kind": "commitment", "text": "Return mower to Glenys", "due": "2026-10-03T16:00", "entities": ["glenys"] },
    { "op": "thread.resolve", "id": "t12" },
    { "op": "relationship.add", "a": "player", "b": "cerys", "amount": 5 }
  ],
  "beat": "Borrowed Glenys's mower; promised it back clean by four.",
  "focus_next": ["glenys", "cerys"],
  "need": []
}
```

Rules:
- Ops are a closed, versioned set. Each module registers the ops it owns.
- The model proposes elapsed time; the engine clamps it to config bounds.
- Unknown ops, unknown entity ids and out-of-range values are rejected, not guessed.
- The `beat` (about 20 words) is the raw material for memory, so no extra call is needed to summarise each turn.

---

## 6. Context assembly and token budget

The context builder fills a fixed budget in priority order and trims from the bottom.

| Priority | Part | Target tokens | Cacheable |
|---|---|---|---|
| 1 | Engine contract, GM style, output schema | ~700 | yes |
| 2 | Active module prompt fragments only | ~500 | yes (per config) |
| 3 | Player input | ~50 | no |
| 4 | State snapshot (stats, clock, location, inventory) | ~600 | no |
| 5 | Due events and fate die | ~100 | no |
| 6 | Open threads (due soonest first, capped) | ~300 | no |
| 7 | Entities in focus (present, named in input, or linked to a hot thread) with top facts | ~500 | no |
| 8 | Last 6 turns verbatim | ~800 | no |
| 9 | Beats since last compaction (max ~20) | ~400 | no |
| 10 | Story-so-far summary (capped) | ~500 | no |
| | **Total** | **~4.5k** | |

Rules:
- Hard cap per part; over-budget parts are trimmed by importance, then recency.
- "In focus" is decided by code: scene location, name or alias match in the input, and threads that reference the entity. No embeddings in the PoC.
- Static parts (1-2) are placed first so provider prompt caching helps where available.
- The debug view shows every part, its token count, and what was trimmed.

### 6.1 Attention mapping

Attention mapping decides which slice of the world the storyteller sees each turn. It is the core of the token plan and is first-class in the design.

How focus is computed (all code, no tokens):
- **Scene:** the current location and entities present there.
- **Input match:** names and aliases mentioned in the player message.
- **Thread links:** entities referenced by open threads that are due soon.
- **Due events:** entities attached to events firing this turn.
- **Decay:** entities touched recently or with high importance stay warm; others cool off and drop out.
- **Module hints:** each module's `focus()` adds what it needs (for example the stat being spent, the faction in the room).

Safeguards against missing something important:
- A one-line **scene roster** (who is present, where we are) is always included.
- The storyteller may return `focus_next`, a short list of entity ids likely to matter next turn (about 20 tokens), which helps on "..." turns.
- The storyteller may return `need: [ids]` when it lacks information. This triggers one extra call and is logged as an attention miss. It should be rare.
- The benchmark tracks the **attention miss rate** and recall probes. If misses are high, widen focus rules before adding any retrieval system.

---

## 7. Memory model

Layers, from hot to cold:

| Layer | Contents | Size policy |
|---|---|---|
| Window | Last N turns verbatim (N ~ 6) | Fixed |
| Beats | One line per turn since last compaction | Compacted every ~20 turns |
| Chapter summaries | ~150-200 tokens each, written by compaction | Older ones merge into story-so-far |
| Story so far | Rolling summary | Hard cap (~500 tokens) |
| Entity facts | Short facts per entity with importance and last-touched turn | Cap per entity; consolidated at compaction |
| Threads | Commitments, goals, debts, mysteries, callbacks | Resolved threads archived; callbacks kept while "warm" |

**Callbacks** are first-class: running jokes, favours owed, nicknames, recurring side characters and promises. Compaction must carry them forward as threads or entity facts. This is the main protection against a story that feels flat after summarising.

**Compaction call** (cheap tier, batched, every ~20 turns or when a budget part overflows): input is the beats, current summary and entity facts; output is a new chapter summary, consolidated facts and thread clean-up as a delta. It goes through the same validator.

---

## 8. State model

State is one versioned document per save, split into slices owned by modules. Core slices are always present.

```
save
  config_id, config_version
  turn, clock
  entities { id: { type, name, aliases, location, facts[], tags[] } }
  threads  [ { id, kind, text, due?, status, entities[], warm } ]
  beats    [ { turn, text } ]
  summaries { chapters[], story_so_far }
  modules  { stats, inventory, relationships, factions, events, dice, ... }
  delta_log [ { turn, ops[], source } ]      // append-only, enables replay
  usage    [ { turn, in, out, cached, cost, latency, retries, model } ]
```

Notes:
- The delta log is cheap and gives replay, rollback and debugging. A heavier event-sourcing system is not needed for the PoC.
- Saves pin `config_version`. Old saves are never reinterpreted under new rules.
- Truth vs belief (NPC knowledge) is deferred. In the PoC, entity facts carry an optional `known_by` list; a full knowledge system is added only if playtests show the need.

---

## 9. Config and modules

### 9.1 Config shape (draft)

```json
{
  "id": "uk-life",
  "version": 1,
  "meta": { "title": "...", "tone": "grounded, dry, British", "content_rating": "romance" },
  "modules": ["stats", "inventory", "relationships", "events", "dice", "offscreen"],
  "offscreen": { "enabled": true, "min_skip_hours": 6, "max_entities": 4, "max_tokens": 600, "scope": ["npc_goals", "threads"] },
  "gm_style": {
    "max_words": 90, "person": "second", "never_decide_for_player": true,
    "interludes": [
      "The moment wobbles and slips out of focus... the Game Master rewinds a few seconds and tries again.",
      "Reality shifts for a heartbeat as the Game Master smooths a crease in the story..."
    ],
    "rollback_note": "The Game Master pauses. That didn't quite work. Try a different approach?"
  },
  "presentation": { "profile": "light", "status_line": ["money", "health", "location", "time"] },
  "time": { "start": "2026-10-03T09:20", "min_per_action": 1, "max_per_turn": 480 },
  "stats": [ { "key": "money", "type": "currency", "start": 45, "display": "GBP" } ],
  "events": {
    "scheduled": [ { "at": "2026-10-05T10:00", "id": "inspection", "text": "Letting agent inspection window opens" } ],
    "conditional": [ { "when": "relationship(player,cerys) > 60", "fire": "romance_beat" } ],
    "random": [ { "table": "street_encounters", "chance_per_hour": 0.15 } ]
  },
  "seed": { "entities": [], "threads": [] }
}
```

### 9.2 Module interface (contract)

Every module implements the same TypeScript interface, so new mechanics never touch the core.

```ts
interface Module {
  id: string;
  configSchema: ZodSchema;          // its slice of the config
  stateSchema: ZodSchema;           // its slice of the state
  ops: Record<string, OpHandler>;   // validates and applies its delta ops
  promptFragment(ctx): string;      // short rules shown to the model only when relevant
  focus(state, input): EntityId[];  // what to pull into context
  due(state, clock): DueItem[];     // scheduled/conditional/random items firing now
  render(state, profile): string;   // deterministic player-facing display
}
```

### 9.3 Initial module set

| Module | Purpose | PoC |
|---|---|---|
| core | clock, entities, threads, beats, summaries | yes |
| stats | bounded numbers and currencies | yes |
| inventory | items and ownership | yes |
| relationships | numeric standing between entities | yes |
| events | scheduled, conditional and random events | yes |
| dice | fate die and thresholds | yes |
| factions | standing and goals | pirate config |
| travel/map | locations and travel time | pirate config |
| offscreen | optional world simulator for NPC activity during time skips | yes, optional per game |
| combat | structured fights | later |
| survival | needs and weather | later |

### 9.3.1 Off-screen simulator (optional module)

A game opts in with `"offscreen": { "enabled": true, ... }`. It is off by default and costs nothing when disabled.

- **Trigger:** the clock advances by at least `min_skip_hours` in one turn (sleep, travel, "wait until Monday"), or a configured number of in-world days pass.
- **Input:** up to `max_entities` NPCs chosen by code (those with open goals or threads that are due), their goals and facts, and the elapsed time. Not the full context.
- **Output:** a small delta only (NPC moved, relationship drift, thread progress, a new message or event waiting for the player). It goes through the same validator.
- **Surfacing:** results are not narrated immediately. They become entries the storyteller can reveal when the player next meets or contacts that NPC, so the world feels alive without spending narration tokens.
- **Budget:** hard `max_tokens` per run, cheap tier, and a per-save daily cap. The benchmark reports its token share and a human rating of whether it improved engagement.
- **Scope in the PoC:** build the module and interface; test it on the UK config first with it both on and off.

### 9.4 Presentation profiles

| Profile | Player sees |
|---|---|
| `novel` | Narration only; no numbers |
| `light` | Narration plus a one-line status |
| `tabletop` | Narration plus stat panel, rolls and thresholds |

The profile only changes the renderer. State and rules are identical, so a world can offer different views to different players later.

### 9.5 Content rating

Config field: `clean | romance | mature`. The rating selects a prompt fragment and the allowed providers.

- Hosted and trial play must follow the provider's usage policy: romance is allowed, explicit scenes fade to black.
- Explicit content is a later, separate surface (BYO key or a provider whose terms allow it, age assurance, separate payment processor). Verify current Stripe, provider and Ofcom rules and take legal advice before building it.
- Sexual content involving minors is hard-blocked everywhere.

---

## 10. LLM layer

- Provider adapter interface: `complete({ system, messages, schema, tier }) -> { json, usage }`.
- Two tiers behind the interface: `strong` (turns) and `cheap` (compaction, out-of-character answers). PoC starts with Claude on both tiers.
- A **mock provider** returns scripted deltas so engine, context and harness work can be built and tested without spending tokens or needing an API key.
- Usage is metered per call: input, output, cached, cost, latency.
- Per-turn guards: max output tokens, max retries (1), per-save token budget in the harness.
- Bring-your-own-key and the hosted trial later plug in at this layer (key passed per request, never stored by us); nothing else changes.

---

## 11. Storage

```ts
interface Store {
  loadSave(id): Save;
  commitTurn(id, { delta, beat, narration, usage, expectedTurn }): void; // atomic
  listSaves(owner): SaveMeta[];
}
```

- PoC: file-backed store (one JSON document plus append-only JSONL logs).
- Next: Supabase implementation of the same interface, with row-level security. `expectedTurn` gives optimistic concurrency now and supports multiplayer later.
- Tables are added only when needed; the first Supabase schema mirrors section 8 rather than the 12-table v1 design.

---

## 12. Testing, benchmark and observability

### 12.1 Harness commands

| Command | Purpose |
|---|---|
| `play` | Interactive CLI session on a config |
| `replay` | Feed a scripted list of player inputs through the engine |
| `baseline` | Same inputs through a naive full-history chat for comparison |
| `report` | Tokens per turn, cost, trimmed parts, rejection rate, recall score |

### 12.2 Golden session
The 121 player messages from the real session (about 4k tokens) become `fixtures/golden-sessions/uk-life-01.json`. The model's replies will differ on replay, so it is used as a token benchmark and a recall checklist, not an exact match.

### 12.3 Test layers
- Unit: every op handler, clock bounds, dice, event firing, budget trimming.
- Replay determinism: delta log reproduces identical state.
- Adversarial inputs: attempts to set money, skip time, contradict state; state must not corrupt.
- Repair paths: forced `fixable` and `game_breaking` drafts from the mock provider (overspending, absent characters, bad ids) must produce the right interlude, a corrected committed turn, and a log entry; rejected text must never appear in the transcript or window.
- Recall probes: scripted questions at turns 50, 100, 200 about early facts and open threads.
- Cross-model: same session on at least two models once the adapter has a second provider.
- Engagement (human): 2-3 testers; session length, "would continue" rating, and a free-text list of what felt flat or broke.

### 12.4 Decision rules from the benchmark
- If the engine misses the token target: tighten budgets, then shrink prompt fragments, then consider a cheap-tier narrator.
- If recall is poor: raise fact caps and callback retention before adding retrieval infrastructure.
- If narration quality drops against the baseline: widen the window before adding calls.
- Embeddings, belief systems and multi-call pipelines are added only when a measured failure demands them.

---

## 13. Designed for, not built

| Future feature | Hook in the PoC |
|---|---|
| Publishing and discovery | Configs are versioned and immutable once published; fields `owner_id`, `visibility`, `forked_from` reserved |
| Stars, favourites, tips | Config and usage records carry ids that ratings and tips can reference later |
| Creator world wizard | Config is pure JSON validated by module schemas; the wizard only needs to emit it |
| Subscriptions and credit packs | Usage is metered per user and per config from day one |
| Hosted trial | Provider adapter plus per-user token budget guard |
| Bring-your-own key | Adapter takes credentials per request |
| Multiplayer | Single-writer state with `expectedTurn`; delta log supports multiple actors later |
| Moderation | Content rating and rejection logs exist; reporting UI comes with publishing |

---

## 14. Repository layout (proposed)

```
/docs
  ARCHITECTURE.md
  adr/                    architecture decision records
/packages
  schema/                 zod schemas: config, state, delta, turn I/O  (contract owner)
  engine/                 pure TypeScript: reducer, validator, clock, dice, events
  modules/                stats, inventory, relationships, events, dice, ...
  context/                context builder, budgets, memory, compaction
  llm/                    adapter, providers, mock, usage metering
  store/                  Store interface, file store (Supabase later)
  runtime/                turn controller: validate-then-release, repair flow, commit
  harness/                CLI: play, replay, baseline, report
/apps
  web/                    Nuxt UI (after harness results)
/configs
  uk-life/  pirate/
/fixtures
  golden-sessions/
AGENTS.md                 shared rules for all agents
```

Proposed tooling: TypeScript, pnpm workspaces, Vitest, Zod, ESLint and Prettier. Nuxt and Supabase are kept for the web app and persistence phase.

---

## 15. Phases and gates

| Phase | Work | Gate |
|---|---|---|
| 0. Contracts | Schemas, delta ops, module interface, budget table, ADRs, `AGENTS.md` | Human approval of contracts |
| 1. Core build (parallel) | Engine and modules, context and memory, LLM adapter and mock, harness, UK config | All unit tests pass on the mock provider |
| 2. Benchmark | Baseline vs engine on the golden session with a real model | Meets or explains misses against section 1.2 targets |
| 3. Playable | Minimal Nuxt chat with debug panel; 2-3 testers | Testers continue unprompted; failure list captured |
| 4. Universality | Pirate config with factions and travel modules | Second config runs without engine changes |
| 5. Next decisions | Supabase, hosted trial, wizard, publishing | Chosen from measured data |

---

## 16. Multi-agent workflow (Cursor)

### 16.1 Tracks and ownership

| Track | Owns | Depends on |
|---|---|---|
| A. Contracts and engine | `packages/schema`, `packages/engine`, `packages/modules` | none (defines contracts) |
| B. Context and memory | `packages/context` | A schemas |
| C. LLM and harness | `packages/llm`, `packages/store`, `packages/harness` | A schemas |
| D. Content and evaluation | `configs/`, `fixtures/`, recall probes, playtest notes | A schemas |
| E. Web (later) | `apps/web` | harness results |

### 16.1.1 Agent setup (decided)

Four development agents run in parallel at most, one per track A to D. Track E starts after the Phase 3 gate.

| Agent | Starts | Notes |
|---|---|---|
| A. Contracts and engine | Phase 0 | Runs first alone to draft the schemas and `AGENTS.md`; B, C and D start once the owner approves the contracts |
| B. Context and memory | Phase 1 | Builds the context builder, attention mapping, memory layers and compaction |
| C. LLM and harness | Phase 1 | Adapter, mock provider, metering, store, CLI and benchmark reports |
| D. Content and evaluation | Phase 1 | UK config, golden session fixture, recall probes, adversarial inputs |

Owner approval is required for: changes to `packages/schema`, changes to the module interface, changes to the token budget table, new runtime dependencies, and any use of the real model API. Everything else is merged on green CI.

### 16.2 Rules
- Agents only edit files in their own directories. Cross-track changes go through a contract change.
- `packages/schema` changes need an ADR and human approval before merging.
- Each track works against the mock provider so no track waits on an API key or another track's runtime code.
- One branch and one PR per track and phase; CI runs lint, typecheck and tests.
- Every PR states which section-1.2 metric it affects and attaches harness output when relevant.
- Cost control: real-model benchmark runs are manual or gated, never part of default CI; each run has a token cap.

### 16.3 Agent prompts to prepare
`AGENTS.md` (shared rules, commands, definition of done), plus a short brief per track containing its inputs, outputs, directories and tests.

---

## 17. Risks

| Risk | Mitigation |
|---|---|
| Flat or generic stories after compression | Callbacks as first-class threads; widen window before adding calls; human engagement tests |
| Repair loops with weaker models | Closed op set, severity-based repair, max two repair calls, rollback with a GM note (section 5.3) |
| Interludes break immersion if frequent | Engine-written templates in the game's tone; interlude rate is a tracked target; escalate model tier or prompt if above 3% |
| Waiting for validation makes the story feel slow | Delta-first output order experiment; measure time-to-story (limits 10s normal, 20s repaired); typing indicator |
| Module interface too rigid for unusual worlds | Prove with two very different configs; add an escape-hatch "freeform note" op only if needed |
| Over-engineering again | Every addition needs a measured failure from the benchmark |
| Prompt fragments grow with each module | Load only relevant fragments; budget enforced per part |
| Agents drifting on contracts | Contract ownership, ADRs, approval gate |
| Explicit-content and payments rules | Rating field now; separate surface later; legal advice before building |

---

## 18. Open questions

### Decided (4 Oct 2026)

1. TypeScript monorepo with pnpm, Vitest and Zod.
2. Harness CLI first, then a minimal Nuxt UI after the benchmark.
3. Anthropic API key will be added as a Cursor secret by the owner. **Reminder: required before the Phase 2 benchmark.** Until then everything runs on the mock provider.
4. The 121 player messages may be committed as a test fixture.
5. UK life sim is the flagship benchmark config; pirate sim is the universality test.
6. The fate die is visible to the player.
7. The working name is `book` and this repository is the home of the monorepo.

8. One model call per turn where possible. The player sees nothing until the draft is validated and committed. Minor bookkeeping errors are fixed silently with a small delta repair; game-breaking drafts trigger an in-world GM interlude, a rewrite, and only the corrected story is shown and saved. A standing two-call pipeline is a later escalation (section 5.3).
9. Four development agents in parallel (tracks A to D), with owner approval for schema, module interface, token budget, new dependencies and real-model API use (section 16.1.1).
10. The off-screen simulator is included as an optional module that each game enables in its config (section 9.3.1).
11. Attention is shown in a debug panel only, not to players.

12. Minor bookkeeping fixes are silent: the normal writing indicator, no GM interlude.
13. After two failed repairs the turn rolls back with an in-world GM note; nothing unvalidated is shown.
14. GM interlude lines are engine-written templates per game (no tokens).
15. Acceptable wait for the story: under 10 seconds on a normal turn, under 20 seconds on a repaired turn.
16. The "delta first, then narration" output order is tested as an early experiment.
17. Interlude and repair history is visible in the debug panel only.

### Build status

Owner approved the plan on 4 Oct 2026 and asked to start the build. See `AGENTS.md` and section 15 for phase gates. The Phase 0 contracts in `packages/schema` are the reference for all other packages.
