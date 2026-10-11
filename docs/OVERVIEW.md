# Book: codebase overview

Working name: `book`. This is a summary of what the repository is for, how it is put together today, and why those choices exist. The detailed plan, token budgets, and decision log live in [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`adr/`](./adr/).

---

## Overall idea

**A long, resumable story-game that stays coherent without resending the whole transcript every turn.**

The player types; a game master (one language-model call) writes a short scene and proposes a structured change to the save. Code owns the truth: time, money, inventory, dice, travel, deadlines, and the status line. The model never writes those fields. Nothing reaches the player until the draft has been validated and committed.

The proof of concept exists to test one claim:

> A game of 200+ turns, in 30–60 minute sessions that can be saved and resumed, can stay coherent and engaging while the context sent per turn stays small and flat (under 6,000 input tokens, and flat from about turn 20 onward).

Publishing, billing, a web UI, a world wizard, and multiplayer are designed for and not built. What is built is a TypeScript monorepo, a CLI harness, two game configs, and the engine those configs run on.

The two books are:

- **Uplands** (`configs/uk-life`): a grounded Swansea student life sim. Flagship for recall, tone, and “does the book stay true after a hundred turns?”
- **Black Water Reckoning** (`configs/pirate`): a Caribbean pirate voyage. Universality test — the same engine and game-master contract, a different seed.

A new book is a JSON config. It chooses modules, fills in numbers and words (tone, travel, catalog, opening premise), and does not fork the engine.

---

## Why this architecture exists

A 121-turn session on a plain chat setup is the origin of the design. By the end, about 35k tokens of history were being resent every turn. Status (money, health, place, time) was model-authored on every reply. Commitments and running jokes survived only if they happened to sit in the window. Cost grew roughly with the square of the number of turns.

A shipped competitor aimed at the same player confirmed the other half of the thesis. Its whole architecture was an ordered list of prompt cards plus one rolling summary. There was no state engine. The status line at the foot of each reply had already drifted inside a single scene: “Wanted (Murder/GBH)” while the player sat handcuffed in a cell. He was not wanted; he was caught. Countable facts written by a model drift. Countable facts owned by code do not.

Those two observations fix the split:

| Kind of knowledge | Who owns it | Why |
|---|---|---|
| Numbers, clock, inventory, dice, travel, whether a purchase happened | Code | They must not drift, and they must replay |
| What it felt like, what someone said, how a scene closes | The model | That is language |
| What still matters next week (a favour, a debt, an inspection) | Structured threads in the save | Cheaper and more reliable than rereading prose |
| What a person remembers | Short facts on that person, written the turn they witnessed it | There is no second knowledge store |

Everything else in the repo is a consequence of keeping that split under a hard per-turn token budget.

---

## Current architecture

```
Player input
    │
    ▼
Turn controller  (runtime)     classify act / continue / ooc
    │
    ▼
Context builder  (context)  ←── save document (store)
    │                          stats, threads, window, facts,
    │                          world sheet, GM notes
    ▼
LLM adapter      (llm)         one strong call → { narration, delta, beat }
    │
    ▼
Validator + reducer (engine + modules)
    │                          hold the draft; repair if needed
    ▼
Commit, then release           player sees only the approved story
    │                          plus an engine-built status line
    ▼
Compaction (cheap call)        when a scene closes: chapter, facts, trim window
```

A role is code unless it needs language understanding. The storyteller is the one expensive call. The archivist (chapter summaries), the out-of-character helper, and the optional off-screen NPC simulator are cheap calls. The world keeper, the validator, and the attention mapper are not model calls at all.

### Repository layout

A pnpm TypeScript monorepo. Packages are pure where it matters: `engine`, `modules`, and `context` have no I/O.

| Package | Job |
|---|---|
| `packages/schema` | Contracts: config, save state, closed op set, module / LLM / store interfaces. Changing these needs an ADR. |
| `packages/engine` | Clock, RNG, validation, applying a draft, thread scale, memory lapse, “does the narration match the book?” |
| `packages/modules` | Optional mechanics: stats, inventory, relationships, events, dice, offscreen, endings, player view. Core is a module too. |
| `packages/context` | Budgeted prompt assembly, attention mapping, compaction request/apply. |
| `packages/runtime` | Turn controller: opening deal, validate-then-release, repair, rollback, compaction after release. |
| `packages/llm` | Provider interface, mock, Anthropic, usage metering, per-save cost caps. |
| `packages/store` | Save interface; file store (one JSON document plus append-only logs) and an in-memory store for tests. |
| `packages/harness` | CLI: `play`, `replay`, `baseline`, `report`, `inspect`, `models`. |
| `configs/` | The books. |
| `fixtures/` | Golden 125-message Uplands session and recall probes. |

There is no `apps/web` yet. Play is the CLI.

### The save is the book

One versioned JSON document per save, pinned to a `config_id` and `config_version`. Old saves are never reinterpreted under new rules. The interesting slices:

- **Clock, entities, inventory, stats** — the factual world.
- **Threads** — commitments, goals, debts, mysteries, callbacks. The long-term plot memory.
- **Window** — last few turns of verbatim prose (normally six; more while a scene is still live).
- **Beats** — one line per turn since the last chapter write.
- **Summaries** — chapter list and a capped “story so far”.
- **Facts on entities** — what that person (or place) remembers or is like.
- **GM notes** — short, private, expiring; never shown to the player and never compacted into long-term memory.
- **Scene** — which stretch of story is live, and whether the GM has closed it.

Replay comes from an append-only delta log, not from a second event-sourcing system. `expected_turn` on commit is optimistic concurrency now and a hook for multiplayer later.

### One call per turn, then code

For an ordinary `act` or `continue` (empty input or `...`):

1. Open a new scene if the last one was closed. Apply a pending ending’s continuation in code if the player is carrying on.
2. Draw one fate die for the turn (deterministic from the save seed). List due events, including overdue threads.
3. Build a budgeted context. Static contract and module fragments go first so provider prompt caching can help.
4. One strong-model call returns JSON: narration, a list of ops (`delta`), a one-line beat, and a few optional flags (`scene_ended`, private `notes`, `at`, `check`).
5. Validate. Schema, module rules, clock bounds, and consistency between the prose and the ops. The narration is held.
6. On failure, repair (below). On success, apply the draft, commit atomically, then release the story plus an engine-rendered status line.
7. If the GM closed the scene (or a beat ceiling was hit), a cheap archivist call rewrites chapter summary and facts. The player already has the story; they do not wait on a failed chapter write.

Out-of-character questions (`OOC:`, parentheses, or a config alias) take a cheap read-only path and change nothing.

The model proposes elapsed time; the engine clamps it. `clock.advance` is a scene’s worth of action. `clock.skip` is a deliberate stretch of sleep, travel, or waiting, with its own cap, so a night can pass without a conversation drifting for hours.

### Validate before the player sees anything

A broken draft is never shown, never stored in the window, and never summarised. Severity is decided in code:

| Severity | Meaning | Repair |
|---|---|---|
| Format failure | The reply was not the required JSON | Cheap reformat; no GM interlude. The provider prefills `{` so the model cannot write prose first. |
| `fixable` | The story is fine; the bookkeeping is wrong | Cheap delta-only repair. Silent. |
| `game_breaking` | The story contradicts the rules or the save | In-world GM interlude (engine templates, no tokens), then a strong rewrite. Only the corrected story is saved. |

Two repair attempts, then rollback: no state change, an in-world note asking the player to try another approach. Extended thinking is off by default; hidden reasoning tokens were billed at the output rate and truncated live replies.

The validator still does not invent ops from prose. If the narration buys a catalog item, travels, or puts something down, the matching ops have to be in the delta or the turn is rejected. A trip that is not refused must end at the place the player asked for. The latest save outranks the last six turns: an `ENGINE NOW` block after the window is the factual status and inventory.

That last rule exists because a model that has just seen six turns of “you are in the kitchen” will keep you in the kitchen even after a committed move. The save is the book; the window is colour.

Before validation, a deterministic tidy pass (ADR 0022) fixes what needs no judgement: an entity id the model wrote for someone already in the save is mapped to that slot, a new person is created before the ops that name them, a thread kind the schema does not know becomes a goal, an op about a good the book never tracked is dropped, and `at` is filled from the one place the player is put in when the GM left it out. The pass never invents a change from a verb; it saves the cheap repair call for cases that need language. Its one edit to prose is a distance to a dated thread ("five hours away", "in a few hours") corrected against the clock (ADR 0023).

### Context stays flat on purpose

Each part of the prompt has a hard token cap. Over-budget parts are trimmed by importance, then recency. The player’s input is never trimmed. Total target is under 6,000, independent of how long the game has run or how big the world is.

What the storyteller sees is chosen in code (attention mapping): current place and who is there, names in the input, hot threads, due events, and a recency/importance decay. No embeddings in the proof of concept. A one-line scene roster always goes in. The storyteller may ask for ids it lacks (`need`); that is logged as an attention miss rather than solved with a retrieval system.

A **world sheet** of catalog ids and prices, place ids, and unmet people sits in every turn prompt so the GM uses the book’s names instead of inventing a second shop. Unmet people stay out of the narration until they share the player’s location.

Static parts (engine contract, GM style, active module fragments) are cacheable. After several playtest additions the contract is the largest single part of the context; the per-turn *variable* slice is still small, which is why input stays flat even as the save grows.

### Memory is layered, and compaction waits for a scene

From hot to cold: private GM notes → verbatim window → per-turn beats → chapter summaries → rolling story-so-far → entity facts → the thread pool.

Compaction is how long-term memory in the save gets written. There is no separate memory service. It fires when the GM sets `scene_ended` and enough beats have accumulated, with a beat-count backstop if a scene never closes. On a forced mid-scene compact, the live scene stays in the window: forgetting who walked in two turns ago is the failure a player actually feels.

The archivist gets a code-written state block, not a licence to copy live balances or unused nicknames. A failed chapter write is held for a few turns rather than retried every turn. Notes never enter this pipeline, so a secret the GM told only itself cannot be laundered into canon.

Figures the archivist would lose are kept by code: each chapter summary carries the clock range it covers, and the stats module keeps a dated log of the last ten money movements in the state snapshot. Energy drains with the clock (per hour awake, restored per hour of `clock.skip`) unless the GM has already priced the stretch, so the GM is not asked to remember to tire the player.

A person’s facts are their memory. The GM writes one short fact per witness, on the turn they saw, heard, or were told something that would change a later scene. Importance 1 lapses after a day, 2 after a week, 3 (a fight) stays. A turn that *says* they will remember, and stores nothing, still stands — next time, they do not remember. The engine does not invent the fact from the prose.

### Threads earn prompt space

Storing a thread is nearly free. Putting it in the prompt is not, and not because of tokens: a model holding ten open plots services none of them and the prose turns into a to-do list.

Scale is hidden from the player:

- **Potential** — an offer, shown once. If it is not taken up, it lapses.
- **Minor** — taken up (`thread.adopt`).
- **Major** — a long matter. At most two. The opening may deal majors.

A third long thread is not refused. The major the player has left alone is set aside: it becomes a minor, keeps its deadline and its consequence, and is offered back for the rest of that scene. After that it goes quiet unless they pick it up or the deadline is close.

Warm means the player *dealt with* the thread recently (named a person or place on it, or opened/adopted it) inside `rewarm_hours`. Standing in its place does not count as dealing with it, and merely sharing a room with someone on it does not bring a cold thread back. A cold thread returns in its place, when named, or as the deadline nears. If the deadline passes unresolved, a due event fires with `on_overdue` and the thread is marked failed. That is how the garden can be ignored for a hundred turns and still lose the inspection.

### Modules, not a mega-engine

Every mechanic implements the same interface: init state, own a closed set of ops, validate and apply them, contribute a prompt fragment, declare focus, list due items, snapshot state, optionally declare `truth` lines the narration must not contradict, and render the player-facing view.

The config lists which modules are on. Built today: stats, inventory, relationships, events, dice, offscreen. Endings are config plus a module helper, not a second evaluator — they fire on the same condition shape as conditional events. An ending may offer a continuation that code applies (time passes, location, forced stats, stripped inventory, a due note for the GM). An ending with no continuation closes the save and costs no model call.

`meta.violence` is a tone dial (`deflect` / `consequence` / `adventure`), not a capability switch. `meta.harshness` scales what a mistake costs and never touches the dice. Presentation (`novel` / `light` / `tabletop`) only changes the renderer.

Travel words belong to the book: ordinary `means`, this world’s `journeys` (sail, jump, …), and `local` steps that stay inside the current place (the rail, the deck). The engine does not arrive already knowing ships. A new mechanic is a new module, not a sentence in the prompt.

### LLM and storage

Two tiers behind one interface: `strong` for turns, `cheap` for compaction, OOC, and format/delta repair. The mock provider returns scripted drafts so tests and the harness never spend tokens. Real Anthropic runs are manual, refuse to start without a cost or turn cap, and read `ANTHROPIC_API_KEY` from the environment.

The file store keeps `state.json` (atomic replace) plus append-only `turns.jsonl` and `log.jsonl`. A crash between log and state can leave an extra record, never a lost one. Supabase is the same `Store` interface, later.

### How you run it

```bash
pnpm check
pnpm book play --config configs/uk-life/config.json --provider mock
```

`replay` feeds the golden session through the engine. `baseline` feeds the same inputs through naive full-history chat. `report` compares tokens, cost, trim, and recall. Inject `--faults` to force the repair paths.

---

## What is done, and what is not

Phase 0 (contracts) and Phase 1 (core build) are implemented, including the playtest-driven ADRs through 0026. Tests run on the mock provider.

Measured on the mock golden replay, per-turn input stays flat (a little over 3k after the later contract additions, still under the 6,000 target). Live Haiku sessions of 34 and 44 turns held at about 4.9k input tokens a turn, flat across chapter writes, at roughly $0.008 a turn; about a quarter of turns needed a cheap repair call and one in thirty was rolled back. Mock replies are short, so the baseline’s growth is understated; the real comparison is the Phase 2 benchmark on a live model, which has not been run in full. Short live sessions drove most of the later ADRs.

Not in this repository yet: `need` / attention-miss handling as a second call, a measured delta-first streaming experiment, the Nuxt UI, Supabase, hosted trial, and the creator wizard. The wizard, when it exists, is meant to emit this config — prose cards over the string-valued parts, countable parts staying structured — not to invent a new kind of stat.

---

## Where to go next

| If you want… | Read |
|---|---|
| Token budgets, turn pipeline, module interface, phase gates | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| Why a given rule exists | [`adr/`](./adr/), numbered in the order the decision was made |
| How to work in the repo | [`../AGENTS.md`](../AGENTS.md) |
| Commands | [`../README.md`](../README.md) |
