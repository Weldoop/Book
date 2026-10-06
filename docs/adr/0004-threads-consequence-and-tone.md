# ADR 0004: threads earn prompt space; violence, harshness and time are per-config

Status: accepted (owner decisions, 4 Oct 2026, after save `live-4`)

## Context

Playing `live-4` wildly exposed a design fault rather than a bug. The two threads seeded by the
`uk-life` config (the letting agent's Monday inspection and "get the garden under control this
weekend") were injected into every single turn's context, ahead of anything the player had done.
Every thread was created `warm: true` and nothing in the codebase ever set `warm` to false, so no
thread could ever go cold. Six turns of assaulting housemates still ended with "The brambles are
exactly where you left them". The game read as rails.

Two more problems surfaced in the same session. The fate die was rolled, logged and honoured, but
never shown to the player, so a failed action was indistinguishable from a railroaded one. And
`time.max_per_turn` of 480 minutes made "sleep until the next day" a game-breaking violation.

## Decisions

### Threads: consequence instead of nagging

A thread no longer buys attention by existing. `Config.threads` sets `max_in_context` (4),
`max_reminders` (2) and `rewarm_hours` (12). `selectThreads` gives prompt space only to a thread
with a deadline inside the re-warm window, a thread involving someone in the scene, or a thread with
reminders left. `ageThreads` spends a reminder for each thread the prompt actually showed and cools
the thread when they run out. The stored pool is unlimited; only the shown set is capped.

What replaces the nagging is `overdueThreads`: an open thread whose deadline has passed raises a due
event carrying its `on_overdue` text, so the garden can be forgotten for a hundred turns and still
lose the inspection. The consequence fires on the turn after the deadline is crossed, matching how
scheduled events already report late, and the thread is then marked `failed` so it asks once.
`Thread.status` gains `failed`; `thread.open` gains `parent` so chains are traceable.

Relevance, not age, decides. Threads the player caused and threads the world set are weighted the
same, and one action may resolve several, so the contract tells the GM to list every
`thread.resolve` it earns and to open follow-ups with `parent` set.

The cap of 4 is about prose, not tokens: a thread costs about 25 tokens, but a model holding ten of
them services none of them and the narration turns into a to-do list.

### Dice are visible or explained, never silent

`dice.visible` turns on tabletop behaviour: the console prints `Fate 3 - Disaster (what was at
stake)` above the narration. The GM decides when an action is risky enough to need the die, and
reports that decision in a new optional `check` field on the draft, so a roll is only shown when it
was actually used. `dice.stat_modifier` additionally asks the GM to name the stat the check leans
on.

When `visible` is false the die stays hidden and the contract instead requires every failure or
partial success to carry a concrete in-world cause, and forbids mentioning dice, odds or luck. A
failed action must never simply fizzle.

### Violence and harshness belong to the config, not the engine

A sword fight with no casualties breaks the pirate game; realistic domestic violence is something
the model will not write. So `meta.violence` picks the behaviour per game: `deflect` (the attempt
fails for a physical reason and the cost lands as social, domestic and legal fallout) or
`adventure` (genre combat, wounds and deaths in bounds, not gory). `uk-life` is `deflect`, `pirate`
is `adventure`. The model's own policy is the ceiling regardless of the setting; the flag works
because it follows the grain of what the model will write rather than fighting it.

`meta.harshness` (`forgiving` / `normal` / `unforgiving`) scales how much a mistake costs. It never
touches the dice, because shifting the bands to punish the player makes the die feel rigged.

### Time is bounded by the world, not by one number

`max_per_turn` stays as the guard against a scene drifting hours by accident. A deliberate stretch
of sleeping, travelling or waiting now uses a new `clock.skip` op with its own cap,
`time.max_skip_minutes`, excluded from the per-turn total. `time.rest_note` describes what rest
means for this character, and a cap of 0 forbids skipping outright, which is how a character that
does not sleep is expressed.

## Also in this change

`presentation.status_line` accepts `turn`. The console prints one dim line naming what the engine
did when a turn did not come back clean. `--log-raw` keeps every model reply verbatim in the turn
log, which is how format drift gets diagnosed.

## Consequence found while implementing

Thread relevance first used the output of `mapAttention`, which falls back to listing every entity
once the higher-priority sources run out. Every thread therefore looked like it involved someone on
screen and stayed warm for ever, reproducing the original bug through a new route. Scene presence
(entities sharing the player's location) plus entities the player named is now the signal, and
naming the player specifically does not count, since the player is in every scene.
