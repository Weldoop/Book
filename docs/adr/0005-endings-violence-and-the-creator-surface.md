# ADR 0005: endings, violence as a tone dial, and where the creator surface goes

Status: accepted (owner decisions, 4 Oct 2026, after reviewing a competitor)

## Context

A saved session of a competitor product was reviewed in detail: Questner, running a custom
community game called "London Life: Realism". The snapshot is worth recording because it is a
working product aimed at the same player as `uk-life`, and because what it does *not* have is as
instructive as what it does.

Its entire architecture is a prompt editor. The system prompt is an ordered list of titled text
blocks ("cards") that the player can rename, reorder, delete, add to, save to a personal library and
browse from a shared one. The game in the snapshot had fifteen: Game Master, Response Guidelines,
Overview, Realm, Player Character, Characters, Plot, Other, Game Master Style, Game Mechanics, Dice
Rolls, Moving to a New Stage, Death & Respawn, NPC Knowledge Boundaries, Memory Delta. A Text/Cards
toggle shows the same prompt as one blob or as chunks. Only the last card is engine-written: a
rolling summary rewritten on a message counter, surfaced to the player as "messages until memory
update".

There is no state engine. "Dice Rolls", "Game Mechanics" and "Death & Respawn" are prose, not code.
The status block at the foot of each reply (cash, legal status, health, inventory, reputation, time,
weather) is model-authored markdown that the client splits off and styles. In the snapshot it had
already drifted: it read `Legal Status: Wanted (Murder/GBH)` while the player was handcuffed,
hooded, booked and locked in a cell. He was not wanted; he was caught. This is direct evidence for
principle 2 of the architecture, from a shipped competitor, at no cost to us.

Three things it does better than this project, which drove the decisions below.

1. **Violence lands.** The player headbutted a custody officer and collected another charge. There
   was no refusal and no deflection, because nothing in the prompt asked for either and the prose
   stayed inside provider policy on its own: brief, clinical, consequence-focused, no gore. Our
   `violence: deflect` was justified in ADR 0004 by "realistic domestic violence is something the
   model will not write". The general form of that claim is wrong. What the model resists is
   gratuitous, lingering, graphic violence, which is a constraint on tone, not on plot.
2. **A story can end and still continue.** It has a Death & Respawn card and a "Continue to next
   stage" button. This project had no run-ending state at all: `health` reaching 0 meant nothing.
3. **A creator can edit the game without reading JSON.** Their cards are the product. Our equivalent
   is hand-writing a 637-line config.

## Decisions

### Violence is a tone dial, not a capability limit

`meta.violence` gains a third mode. `deflect` (the attempt fails for a physical reason; nothing
lands) is kept for cosy games. `consequence` is new: the attempt lands, is reported plainly in a
clause or two with no gore and no dwelling, the world answers in proportion, and the cost goes in
the delta as injury, money, standing and trouble. `adventure` is unchanged.

`uk-life` moves to `consequence`. Deflection reintroduced the fault ADR 0004 was written to fix from
the other side: six turns of assaulting housemates produced no consequence because the attempts
never landed. A grounded sim in which the player cannot be hit is less realistic, not more.

### Endings end the book, and may offer a way on

Books end. A game should be able to end, and should then offer to carry the story on somewhere else
rather than resetting.

`Config.endings` is an ordered list. Each ending has a `when` condition reusing `ConditionSchema`, so
no new evaluator was needed, plus a `title` and engine-written `text` in the game's voice. The
engine checks endings after a turn is applied and committed; the first unfired match wins, and
`State.endings_seen` stops one firing twice.

An ending may carry a `continue` block. It is applied by code on the player's next input: time
passes by `skip_minutes`, the player is moved to `location`, `set_stats` are forced, inventory is
stripped if `clear_inventory`, and `note` is handed to the GM as a due event describing the
situation the new scene opens on. So the continuation costs no tokens and cannot drift, and the GM
is told where it is rather than left to guess. An ending with no `continue` block is final: further
input returns the ending text with outcome `ended` and makes no model call.

`uk-life` gets two endings, `charged` and `admitted`, with a hidden `jeopardy` stat driving the
first. That stat is the deliberate answer to the competitor's drifted `Legal Status` line: legal
exposure is a bounded number the engine owns and the GM may only move through a validated op.

### Prose cards are the creator surface, and they belong to the wizard

The card model is adopted in principle but deferred, because the wizard is out of scope for the
proof of concept. Recorded now so the hooks are right:

- The config splits in two. Prose the model reads (`meta.premise`, `meta.tone`,
  `gm_style.extra_rules`, entity facts, module prompt fragments) becomes cards. Anything countable
  stays JSON with a form later. This follows principle 2 rather than fighting it, and it means cards
  are a view over parts the schema already validates, not a second source of truth.
- Cards are reorderable only inside context budget parts 1 and 2 (engine contract, GM style, active
  module fragments). Parts 3 to 10 stay engine-assembled in priority order. The reorderable region
  is exactly the region that is prompt-cacheable, so creator control costs nothing.
- Card identity is reserved as `{ id, title, body, order, source_card_id? }`, which makes a shared
  card library a later query rather than a migration.

### Rejected: "assume the player is right"

Their Response Guidelines card says: "If the player refers to something you don't remember: assume
they are 100% right and go along with it." It is an elegant answer to having no memory, and it is
rejected here. Taken literally it licenses the model to author state the engine owns: a player
claiming "I've got £500 on me" would produce a draft the validator must reject, so the rule would
manufacture the repairs it was meant to avoid. The GM contract already requires a concrete in-world
cause for any failure, which covers the immersion case without handing over the ledger. It may
return later as an optional card a creator can switch on for their own game.

### Deferred

- **Player-facing retry** (regenerate a turn, edit the last input). The delta log makes it possible
  by replaying to turn N-1, but it touches the store contract and the repair ladder, so it waits
  until after the Phase 2 benchmark.
- **Stages as a first-class concept.** Aligning compaction boundaries with scene transitions, and
  giving the player a "continue" button instead of typing `...`, is still open. It depends on
  measuring whether the current fixed trigger (20 beats) actually cuts summaries mid-scene.

### Scope and sequencing

- The Phase 3 UI is for the owner and testers: no auth, no funnel, no anonymous play. The one cheap
  decision taken now is that usage meters against an opaque session id rather than a user id, so
  play-before-signup is possible later without a schema change.
- When that UI is built it is mobile-first from the first commit: `dvh` units, keyboard-resize
  handling, serif body text, and persisted text-size and theme applied before first paint. Reading
  comfort is the product. A PWA (manifest, install prompt) stays out of scope.
- Community story sharing (a player publishing a finished playthrough) goes to section 13.

## Consequences

Contract changes: `Config.endings`, `ContinuationSchema`, `EndingSchema`, the third `meta.violence`
mode, `State.ending`, `State.endings_seen`, and the `ended` turn outcome.

Endings are checked on every committed turn, which is a condition evaluation over state and costs no
tokens. A continuation costs no tokens either. A final ending saves a model call.

Context cost, measured on the 125-turn golden session with the mock provider: average input per turn
goes from 2,809 to 2,937, up 128 tokens (4.6%), against a budget target of under 5k. The rise is the
longer `consequence` fragment, the `jeopardy` rule and stat, and two extra seeded places. Most of it
(about 10k of the 16k cumulative increase) lands in the cacheable static block, which is the cheap
kind of growth. Flatness is unaffected: turn 25 reads 2,927 and turn 125 reads 2,818.

The deflect-to-consequence switch is the first change in this project that makes the game harsher
rather than safer, and it has not yet been played against a real model. The Phase 2 benchmark should
include a session that provokes it.
