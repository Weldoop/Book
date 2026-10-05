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
| Model calls per turn | 1 normally; at most 3 including repairs (plus a batched cheap call when a scene closes) |
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
- Layered memory (recent window, beats, summaries, threads, the GM's private notes).
- Scenes declared by the GM, with compaction and window trimming aligned to them (section 7.3).
- Token metering and a debug view of the exact context sent each turn.
- Replay and benchmark harness (baseline full-history vs engine).
- Two hand-written configs: UK life sim first, Pirate Caribbean second.
- Presentation profiles (novel, light, tabletop) set by the config.
- Content rating field in the config.
- Endings that close the story, each able to offer a deterministic continuation (section 5.4).
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

 After a turn commits (when a scene closes, cheap model, batched):
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
| Archivist (summaries, fact consolidation) | Cheap-model call, batched at scene boundaries (section 7.2) | small |
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

### 5.4 Endings and continuations (ADR 0005)

A book ends. A game should be able to end too, and should then offer to carry the story on somewhere
else rather than resetting to turn 1.

`config.endings` is an ordered list. Each entry has a `when` condition (the same shape conditional
events use, so there is no second evaluator), a `title`, and engine-written `text` in the game's
voice. After a turn is applied, the engine takes the first unfired ending whose condition holds;
`state.endings_seen` stops one firing twice.

An ending may carry a `continue` block, which the engine applies on the player's next input:

| Field | Effect, all in code |
|---|---|
| `skip_minutes` | Time passing between the ending and the new scene (unconscious, remanded, recovering) |
| `location` | Where the player is moved to; must already exist in state |
| `set_stats` | Stats forced to a value, for example money to 0 after confiscation |
| `clear_inventory` | Strips what the player was carrying |
| `note` | The situation, handed to the GM as a due event so it is told where the scene opens |

So a continuation costs no tokens and cannot drift. An ending with no `continue` block is final:
further input returns the ending text with outcome `ended` and makes no model call.

Endings are what make non-numeric jeopardy worth owning in code. `uk-life` carries a hidden
`jeopardy` stat that the GM raises through a validated op when the player does something a court
would care about, and the `charged` ending fires at the ceiling. The alternative - a model-authored
"Legal Status" line - is what a competitor ships, and in the session reviewed for ADR 0005 it had
already drifted to "Wanted" while the player sat in a cell.

### 5.5 Model output contract (draft)

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
  "need": [],
  "check": { "what": "talking Glenys round", "stat": "charm" }
}
```

Rules:
- Ops are a closed, versioned set. Each module registers the ops it owns.
- The model proposes elapsed time; the engine clamps it to config bounds. `clock.advance` covers the
  action and is capped by `time.max_per_turn`; `clock.skip` covers a deliberate stretch of sleeping,
  travelling or waiting and is capped separately by `time.max_skip_minutes`, which is how a full
  night becomes legal without letting a scene drift for hours by accident.
- `check` is set only when the GM resolved the action with the fate die. It is what lets the engine
  show the player a roll that was actually used, rather than one drawn every turn regardless.
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
| 6a | The GM's private notes from the last few turns (ADR 0006) | ~120 | no |
| 6b | World sheet: catalog ids and prices, place ids, unmet people (ADR 0007) | ~350 | no |
| 7 | Entities in focus (present, named in input, or linked to a hot thread) with top facts | ~500 | no |
| 8 | Last 6 turns verbatim (more while a scene is still running, trimmed to the budget) | ~800 | no |
| 9 | Beats since last compaction (max ~20) | ~400 | no |
| 10 | Story-so-far summary (capped) | ~500 | no |
| | **Total** | **~4.9k** | |

Rules:
- Hard cap per part; over-budget parts are trimmed by importance, then recency.
- "In focus" is decided by code: scene location, name or alias match in the input, and threads that reference the entity. No embeddings in the PoC.
- Static parts (1-2) are placed first so provider prompt caching helps where available.
- The debug view shows every part, its token count, and what was trimmed.
- Parts 1-2 are the only region a creator may reorder (ADR 0005). Prompt order changes behaviour, so
  the eventual card editor gets control of exactly the block that is static and cacheable; parts
  3-10 stay engine-assembled in priority order so the budget cannot be reordered out of shape.

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
| GM private notes | Short reminders the GM wrote to itself | Expire after `notes.ttl_turns`; never shown to the player |
| Window | Last N turns verbatim (N ~ 6, or the live scene) | Fixed |
| Beats | One line per turn since last compaction | Compacted when a scene closes, or at `scenes.max_beats` |
| Chapter summaries | ~150-200 tokens each, written by compaction | Older ones merge into story-so-far |
| Story so far | Rolling summary | Hard cap (~500 tokens) |
| Entity facts | A person's memory, or a trait of a place. Importance 1 lapses after a day, 2 after a week, 3 stays | Cap per entity; consolidated at compaction |
| Threads | Commitments, goals, debts, mysteries, callbacks | Pool unlimited; at most `threads.max_in_context` reach the prompt |

**Callbacks** are first-class: running jokes, favours owed, nicknames, recurring side characters and promises. Compaction must carry them forward as threads or entity facts. This is the main protection against a story that feels flat after summarising.

### 7.1 Threads earn prompt space (ADR 0004)

Storing a thread is nearly free; putting it in the prompt is not, and not because of tokens. A model
holding ten open threads services none of them and the prose turns into a to-do list. So the thread
pool is the long-term memory and the prompt sees only a few of them:

- A thread reaches the prompt when its deadline is inside `threads.rewarm_hours`, when the player
  just named a person or place on it, or when one of those is in the scene and the thread is still
  warm. A major that was set aside is also listed while it is still warm, so it can be offered
  again. At most `threads.max_majors` of those slots are majors. At most `threads.max_in_context` in all.
- At most `threads.max_majors` majors stay in the lead. Opening or adopting another sets the one
  the player has left alone back to a minor, keeps its deadline, and flags it as having been a
  major. Naming a person or place on it, or standing in one of its places, counts as touching it.
  Sharing a room with someone does not. If the deadline passes while it is still open, the overdue
  consequence still fires.
- Each turn spends one reminder per thread actually shown. After `threads.max_reminders` unprompted
  reminders the thread goes cold and leaves the prompt. It stays in state.
- A cold thread with a deadline comes back as the deadline approaches.
- An open thread whose deadline passes raises a due event carrying its `on_overdue` text, then is
  marked `failed`. This is what replaces nagging: the garden can be ignored for a hundred turns and
  still lose the inspection.
- "On screen" means entities sharing the player's location plus entities the player named. It is
  deliberately narrower than attention mapping, which falls back to every entity and so cannot tell
  whether a thread is live.
- Player-created and config-seeded threads are weighted the same, one action may resolve several,
  and a resolution may open a follow-up with `parent` set so chains are traceable.

### 7.2 Compaction as built

Compaction is how the long-term memory in the save gets written. There is no separate memory service
and no retrieval step: `state.summaries` and `state.entities[].facts` are ordinary fields of the save
document, and compaction is the process that rewrites them.

- **Trigger:** scene-aware (ADR 0006). Checked at the end of a turn, after the draft has been
  applied. It fires when the GM has closed the scene and there are at least `scenes.min_beats` beats
  since `summaries.last_compacted_turn`, or unconditionally at `scenes.max_beats` beats. The first
  case is the normal one and lands in the gap between scenes, where nothing is lost. The second is a
  backstop against a GM that never closes a scene, and in that case `windowKeep` holds the live
  scene's turns verbatim (up to `scenes.keep_scene_turns`) instead of cutting it to the last 6.
- **Call:** one cheap-tier call, in line with the turn rather than on a background worker. It is
  best-effort: if it fails or cannot be parsed, the state is left alone and the next turn retries.
  The player never waits on a failed compaction.
- **Input:** a code-written state block (location and module snapshots, including money), the
  current story-so-far, the beats since the last compaction, open threads, and the full fact list
  of every entity touched since then. Whole entities only, because a partial list would silently
  drop facts when the reply replaces it. The archivist is told not to copy live balances, and that
  a nickname counts only when a beat used it.
- **Output:** a dedicated `CompactionResult` (`chapter_summary`, `story_so_far`, `facts`,
  `resolve_threads`), not a delta. It has its own parser and is applied by `applyCompaction`, so it
  does not travel through the turn validator or the op set.
- **Effect:** the chapter is appended, story-so-far is replaced and capped at ~500 tokens, each
  listed entity's facts are replaced and capped at 8, finished threads are resolved, beats are
  cleared and the verbatim window is trimmed (to the last 6 turns between scenes, or to the live
  scene when a forced compaction lands mid-scene).

The caps are the whole point: this is what keeps the per-turn context flat as the save grows.

A chapter write that cannot be parsed does not retry on every following turn. The engine sets
`summaries.compaction_hold_until` and skips the beat-ceiling backstop until that turn. A scene the
GM actually closed still compacts. The validated narration is shown before that write runs, so the
player is not waiting on it; the turn is committed once the write has succeeded or been held
(ADR 0007). The archivist still does not move the player. A change of room is an `entity.move`,
checked like any other op.

The GM's private notes (section 7.3) are deliberately not part of any of this. Compaction never sees
them, so nothing the GM told only itself can be laundered into long-term memory.

### 7.3 Scenes and private notes (ADR 0006)

A scene is the unit compaction waits for. Whether one has closed is a language judgement, so the GM
makes it: `TurnDraft.scene_ended` costs about five output tokens and no extra call. `state.scene` is
`{ index, started_turn, closed }`; the engine marks it closed when the GM says so and opens the next
one on the player's next input, the same lazy pattern an ending's continuation uses. The context
tells the GM which scene it is in and how many turns it has run, so it can answer the question it is
being asked.

The console prints one dim line, `--- the scene closes ---`, only on a turn the GM closed and only
when an ending is not already doing the talking. That is the competitor's "move to a new stage"
button in a CLI: an offer that appears only when it cannot interrupt.

Private notes are a register below a thread. `TurnDraft.notes` is a list of short strings the engine
stores as `{ turn, text }` and renders into a `## YOUR PRIVATE NOTES` section, newest first, capped
by `notes.max_in_context`. They are the one part of the context never shown to the player, and they
never enter the window, the beats or the summaries.

They expire on purpose. `notes.ttl_turns` is short, and the contract says what to do about that: if a
note still matters, open a thread or add an entity fact. A note is a reminder to the GM; a thread is
a promise to the story. So the GM gets a cheap place to park an intention and an explicit upgrade
path when the intention turns out to matter. Notes are a structured field rather than inline
`[HIDDEN: ...]` text, because the reply is already JSON and a field cannot leak into prose; a
`[HIDDEN: ...]` written into the narration anyway is stripped and lifted into `notes` before
validation. Setting `notes.enabled: false` removes the state, the contract block and the output key,
so a game that does not want them pays nothing.

---

## 8. State model

State is one versioned document per save, split into slices owned by modules. Core slices are always present.

```
save
  config_id, config_version
  turn, clock
  entities { id: { type, name, aliases, location, facts[], tags[] } }
  threads  [ { id, kind, text, due?, status, entities[], warm, reminders, parent?, on_overdue? } ]
  beats    [ { turn, text } ]
  scene    { index, started_turn, closed }      // closed is set by the GM, opened on next input
  notes    [ { turn, text } ]                   // the GM's private notes; expire, never rendered
  ending   { id, turn, continuable } | null     // set while an ending waits on the player
  endings_seen [ id ]                           // so one ending cannot fire twice
  summaries { chapters[], story_so_far }
  modules  { stats, inventory, relationships, factions, events, dice, ... }
  delta_log [ { turn, ops[], source } ]      // append-only, enables replay
  usage    [ { turn, in, out, cached, cost, latency, retries, model } ]
```

Notes:
- The delta log is cheap and gives replay, rollback and debugging. A heavier event-sourcing system is not needed for the PoC.
- Saves pin `config_version`. Old saves are never reinterpreted under new rules.
- A person's facts are what they remember. Trivial ones lapse; a fight does not. There is no second knowledge store. They still only cover what that person saw, heard, or was told.

---

## 9. Config and modules

### 9.1 Config shape (draft)

```json
{
  "id": "uk-life",
  "version": 1,
  "meta": {
    "title": "...", "tone": "grounded, dry, British", "content_rating": "romance",
    "violence": "deflect", "harshness": "normal"
  },
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
  "presentation": { "profile": "light", "status_line": ["turn", "money", "health", "location", "time"] },
  "time": {
    "start": "2026-10-03T09:20", "min_per_action": 1, "max_per_turn": 480,
    "max_skip_minutes": 840, "rest_note": "A full night is seven to nine hours"
  },
  "threads": { "max_in_context": 4, "max_reminders": 2, "rewarm_hours": 12 },
  "scenes": { "min_beats": 8, "max_beats": 20, "keep_scene_turns": 12 },
  "notes": { "enabled": true, "ttl_turns": 4, "max_in_context": 3, "max_chars": 200 },
  "dice": { "sides": 100, "thresholds": [10, 25, 50, 75, 90], "visible": false, "stat_modifier": false },
  "stats": [ { "key": "money", "type": "currency", "start": 45, "display": "GBP" } ],
  "events": {
    "scheduled": [ { "at": "2026-10-05T10:00", "id": "inspection", "text": "Letting agent inspection window opens" } ],
    "conditional": [ { "when": "relationship(player,cerys) > 60", "fire": "romance_beat" } ],
    "random": [ { "table": "street_encounters", "chance_per_hour": 0.15 } ]
  },
  "endings": [
    {
      "id": "charged",
      "when": { "kind": "stat", "key": "jeopardy", "op": ">=", "value": 100 },
      "title": "Charged",
      "text": "The student year ends in a custody suite off Alexandra Road...",
      "continue": {
        "label": "Wake up in a cell and carry on from there",
        "location": "custody-suite",
        "note": "Morning in the cells. Open on waking; do not recap the arrest.",
        "skip_minutes": 600,
        "set_stats": { "jeopardy": 45, "energy": 25 },
        "clear_inventory": true
      }
    }
  ],
  "seed": { "entities": [], "threads": [ { "kind": "goal", "text": "...", "due": "...", "on_overdue": "..." } ] }
}
```

`meta.violence` is a tone dial, not a capability limit. `deflect` means the attempt fails for a
physical reason and nothing lands, which is what a cosy game needs. `consequence` means it lands,
reported plainly in a clause or two with no gore and no dwelling, and the cost arrives as injury,
money, standing and legal trouble; this is what a grounded setting needs, and `uk-life` uses it.
`adventure` means genre combat where blows land and characters can die, which is what a pirate or
fantasy game needs. The model's own policy is the ceiling regardless of the setting, and the reason
`consequence` works is that brief, clinical, consequence-focused violence sits well inside it
(ADR 0005). `meta.harshness` scales what a mistake costs and never touches the dice.
`dice.visible` shows the roll to the player; when it is false, the contract instead requires every
failure to carry a concrete in-world cause. See ADR 0004.

`scenes` sets when compaction is allowed to happen and how much of a live scene survives a forced
one; `notes` sizes the GM's private notes and can switch them off entirely. See ADR 0006 and
section 7.3.

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
| Game wizard as prose cards | The wizard edits the string-valued parts of the config as an ordered list of titled cards; countable parts stay structured. Cards are reorderable only inside budget parts 1-2 (ADR 0005) |
| Shared card library | Card identity reserved as `{ id, title, body, order, source_card_id? }`, so "save to my cards" and "browse cards" are a query rather than a migration |
| Sharing a finished playthrough | Endings mark where a story closed; the delta log and beats already hold everything a shareable write-up needs |
| "Move to the next scene" button | `scene_ended` already marks the turns where an offer cannot interrupt, so the UI puts a button where the CLI prints a line (section 7.3) |
| Player-facing retry and edit-last-input | The delta log replays to turn N-1, so an undo needs no inverse ops (deferred in ADR 0005) |
| Play before signup | Usage meters against an opaque session id rather than a user id, so anonymous play needs no schema change |
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
| 3. Playable | Minimal Nuxt chat with debug panel, mobile-first, testers only (no auth, no funnel); 2-3 testers | Testers continue unprompted; failure list captured |
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

### Decided after live play (4 Oct 2026, saves `live-3` and `live-4`)

18. Extended thinking is off by default. Hidden reasoning tokens are billed at the output rate and
    were consuming the output cap, truncating replies (ADR 0003).
19. A malformed reply is a format problem, not a story problem: it gets a cheap reformat with no GM
    interlude, and the provider prefills `{` so the model cannot write prose before the JSON
    (ADR 0003).
20. Threads earn prompt space and ignored threads bite later through `on_overdue` instead of being
    repeated every turn (ADR 0004, section 7.1).
21. Violence is per config: `deflect` for grounded settings, `adventure` for genre combat. Harshness
    is a separate dial that scales consequences and never the dice (ADR 0004).
22. `clock.skip` with its own cap makes sleeping legal; `time.rest_note` and a cap of 0 express a
    character that does not sleep (ADR 0004).
23. A roll is either shown to the player (`dice.visible`) or explained in-world. A hidden die must
    never leave an action looking as though it fizzled for no reason (ADR 0004).
24. The status line may show the turn number, the console names what the engine did when a turn did
    not come back clean, and `--log-raw` keeps raw replies for diagnosis.

### Decided after reviewing a competitor (4 Oct 2026)

A saved session of Questner's "London Life: Realism" was analysed in full. Its whole architecture is
an ordered list of editable prompt cards plus one engine-written rolling summary; there is no state
engine, and its model-authored status line had already drifted within a single scene. See ADR 0005.

25. Violence is a tone dial with three modes: `deflect` (cosy, nothing lands), `consequence` (it
    lands, told plainly and briefly, and the cost is social, legal and medical) and `adventure`
    (genre combat). `uk-life` moves to `consequence`, because a grounded sim where the player cannot
    be hit is less realistic, not more.
26. A story may end. `config.endings` fires on the same condition shape as conditional events, and
    an ending may offer a continuation that code applies: time passes, the player is moved, stats
    are forced, possessions are stripped, and the GM is handed the opening situation as a due event.
    An ending with no continuation closes the save and costs no model call (section 5.4).
27. The creator surface is prose cards over the string-valued parts of the config, with countable
    parts staying structured. Adopted in principle, built with the wizard, not in the PoC.
28. "Assume the player is right about anything you do not remember" is rejected as an engine rule:
    it would license the model to author state the engine owns and would manufacture the repairs it
    was meant to avoid. It may return as an optional creator card.
29. Player-facing retry and edit-last-input are deferred until after the Phase 2 benchmark.
30. Stages as a first-class concept (compaction boundaries aligned to scene transitions, plus a
    "continue" button) were left open here pending evidence that the fixed 20-beat trigger cuts
    summaries mid-scene. Closed by ADR 0006: the trigger is a turn count and scenes are not a fixed
    number of turns, so a mid-scene cut is guaranteed rather than possible, and it needs no
    measuring. See items 33-35.
31. The Phase 3 UI is for the owner and testers only: no auth, no funnel, no anonymous play. Usage
    meters against an opaque session id so play-before-signup is possible later.
32. When the UI is built it is mobile-first from the first commit, with serif body text and
    persisted size and theme applied before first paint. A PWA stays out of scope.

### Decided after the second competitor pass (4 Oct 2026)

33. A scene is a first-class concept, declared by the GM through `scene_ended` rather than inferred
    by code or asked for in a second call. The engine decides whether the close is worth acting on
    (section 7.3, ADR 0006).
34. Compaction waits for a scene to close once `scenes.min_beats` beats have accumulated, with
    `scenes.max_beats` as a backstop. On a forced mid-scene compaction the live scene stays in the
    verbatim window, because a GM forgetting who walked in two turns ago is the failure a player
    would actually feel.
35. The "move to a new stage" affordance is an offer that only appears when it cannot interrupt: in
    the CLI, a single dim `--- the scene closes ---` line on the turn the GM closed the scene.
36. The GM keeps private notes: short, never shown to the player, expiring after `notes.ttl_turns`,
    and never seen by compaction. The expiry is the design - the contract tells the GM to promote a
    note that still matters into a thread or an entity fact, so the cheap register has an explicit
    upgrade path to the expensive one.

### Decided after the Uplands playtest (4 Oct 2026)

37. Each new save deals its own first chapter when `config.opening` is set. The GM deals the cast
    (`dealt_by` stays unset until a future card). Generated people and threads live only in the
    save. Unmet people stay out of the narration until they share the player's location. `openBook`
    runs on the play path only; a failed opening leaves the seed. See ADR 0007.
38. A world sheet of catalog ids, prices, places and unmet people is in every turn prompt and in
    delta repair. Places cap at 24. The sheet's budget is 350 tokens.
39. The validator checks and applies legal ops. It does not infer a move from prose. A mentioned
    place is created immediately with `unvisited`. Travel the GM allows is an `entity.create` or a
    cleared tag plus `entity.move` in that same delta.
40. `scene_ended` stays the GM's call. The beat ceiling still compacts, without pretending the
    scene ended. A failed chapter write is held for five turns. Validated narration is released
    before the archivist runs.
41. Warnings the player must not miss (conditional events, overdue promises) are printed by the
    engine under the narration. Energy joins the Uplands status line. Relationship scores stay off
    the player UI and are felt only in the writing.
42. Other people know only what they have seen, heard, or been told. There is no knowledge store.

### Decided after the second Uplands playtest (4 Oct 2026)

43. The validator still does not invent ops from prose. It rejects a turn whose bookkeeping does
    not match what was played. Optional `at` must be the player's place when it is set. A trip that
    is not refused must end at a matching place, or at a place created in that delta; the second
    refusal in a row is game-breaking so the rewrite has to narrate the departure. A catalog item
    the narration buys, or that the player eats or puts down while still holding it, needs the
    inventory and money ops. A new thread that repeats an open one is dropped. The archivist sees
    engine state and must not copy a live balance or an unused nickname. See ADR 0008.

### Decided after the pirate playtest (5 Oct 2026)

44. A stat op accepts the id or the label, ignoring case, spaces, and hyphens, and stores the id.
    The state block shows that id beside the label. An unknown `check.stat` is fixable. Pirate does
    not ask for a skill. Its d20 bands are percentages (`5, 25, 50, 75, 90`); Uplands is unchanged.
    A voyage is a trip, and a step to the rail or the deck is not. A priced purchase is a whole
    number of catalog units added to the player; a smaller sum is fixable. `clock.advance` past one
    scene but inside the skip cap is fixable and should be `clock.skip`. Pirate may skip a week.
    A word currency is written after the number. A turn that starts under the cost cap may finish
    its repair calls; the next turn stops. The validator still does not invent the op. See ADR 0009.

### Decided with the universal book (5 Oct 2026)

45. The engine and the game master are the same for every book. The book seeds them. `config.travel`
    names ordinary trips, this world's journeys, and the steps that stay inside the current place.
    Those lists are empty of ships, deserts and airlocks until the book fills them. The opening
    names this book's title and premise. Memory, the ops, and the modules stay the engine's. A new
    mechanic is a module, not a sentence. See ADR 0010.

### Decided after the third Uplands playtest (5 Oct 2026)

46. The save outranks the verbatim window. `ENGINE NOW`, placed after the last six turns, is the
    status line and what the player is carrying, and the contract says it is factual. A trip stops
    at the place: "for a cob" and "to buy milk" are not part of the destination. A repair stays in
    the debug view; the story does not announce it. Warm and cold threads are unchanged. A person's
    facts are their memory: a passing one lapses after a day, an ordinary one after a week, and a
    fight does not lapse. See ADR 0011.

### Decided with major and minor threads (5 Oct 2026)

47. A thread has a scale the player does not see: potential, minor, major. The game master sets it.
    An offer is made once and lapses if it is not taken up. Taking it up is `thread.adopt` to minor.
    At most two majors are open. A minor may become the next major when a slot is free, and it can
    name the major it came from. Resolving a major leaves its minors open. A thread is listed only
    when a person or place on it is in the scene, the player just named them, or the deadline is
    close. The opening deals majors. See ADR 0012.

### Decided with demotion (5 Oct 2026)

48. Two majors still run. A third long matter is not refused. The major the player has left alone
    (oldest `last_interacted_turn`, then older opening, then id) becomes a minor, keeps its deadline
    and its consequence, and is flagged `was_major`. The prompt offers it back while it is warm,
    including off-scene. After those reminders it goes cold like any other minor. Ignoring it past
    the deadline still fires the overdue consequence. The player never hears the scale. See ADR 0013.

### Build status (5 Oct 2026)

Phase 0 (contracts) and Phase 1 (core build) are implemented, plus the fixes from the live sessions
and the ADR 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0012 and 0013 changes; 396 tests pass.

| Area | State |
|---|---|
| Contracts, engine, modules (stats, inventory, relationships, events, dice, offscreen) | done |
| Turn runtime: validate-then-release, delta repair, GM interlude rewrite, rollback, compaction, off-screen simulator | done |
| Context builder, attention mapping, memory compaction | done |
| Mock and Anthropic providers, file store, harness CLI (play, replay, baseline, report, inspect, models) | done; Anthropic adapter tested only with injected fetch |
| UK and pirate configs, golden session, recall probes | done |
| Thread lifecycle and overdue consequences, per-config violence and harshness, `clock.skip`, visible dice | done; not yet exercised against a real model |
| Endings with deterministic continuations, `violence: consequence`, `jeopardy` stat on `uk-life` | done; not yet exercised against a real model |
| Scene-aware compaction and the GM's private notes | done; the mock never closes a scene or writes a note, so both need a real model |
| World sheet, dealt opening, catalog item ids, release-before-archivist (ADR 0007) | done; opening is exercised with the mock, not yet against a real model |
| Trip, price and thread checks; archivist state block (ADR 0008) | done; exercised with the mock, not yet against a real model |
| Stat ids, pirate die bands, voyages, whole-unit prices, week-long skip (ADR 0009) | done; exercised with the mock, not yet against a real model |
| Travel words and the opening premise come from the book (ADR 0010) | done; exercised with the mock, not yet against a real model |
| Factual status after the six turns, trip errands, fading NPC memory (ADR 0011) | done; exercised with the mock, not yet against a real model |
| Major, minor and potential threads (ADR 0012) | done; exercised with the mock, not yet against a real model |
| A third major sets the quiet one aside (ADR 0013) | done; exercised with the mock, not yet against a real model |
| Real-model benchmark (Phase 2) | three short live sessions played; full golden-session benchmark not yet run |
| `need` / attention-miss handling, delta-first experiment results | not yet implemented / not yet measured |
| Nuxt UI, Supabase, hosted trial, wizard | later phases |

First mock benchmark (125 turns, estimates only, mock replies are short so baseline growth is understated): engine input stays flat at about 2.4k tokens per turn from turn 25; baseline grows to about 7.7k by turn 125.

After ADR 0005 the same replay averages 2,937 input tokens per turn (2,927 at turn 25, 2,818 at turn
125), up 128 on the run before it. The rise is the `consequence` fragment, the `jeopardy` rule and
stat and two extra seeded places, and most of it sits in the cacheable static block. Still well
inside the 5k target, and still flat.

After ADR 0006 it averages 3,217 (3,216 at turn 25, 3,108 at turn 125), up a further 280. Almost all
of that is the two new contract sections, so all but about 800 tokens of the 35k cumulative rise is
in the cacheable static block. The contract is now the largest single part of the context and wants a
dedicated trim pass before the Phase 2 benchmark.
