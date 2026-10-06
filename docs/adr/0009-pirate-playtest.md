# ADR 0009: the book the model actually writes

Status: accepted (owner decision after the pirate playtest, 5 Oct 2026)

## Context

A Haiku session of Black Water Reckoning, capped at $1.50, kept the story: the broken oath, the
dying hull, the empty purse. The engine also spent most of the evening on repairs. Of 148 story
turns, 63 did not commit on the first draft. The failures were mechanical:

- Stat ops used the status label (`Gold`, `Crew morale`, `Hull`) or a hyphenated guess
  (`crew-morale`, `infamy-with-the-crown`). The id schema rejected them before the stats module
  saw them. `check.stat: "seamanship"` failed the same way, and the book has no skills.
- The pirate die is a d20 whose thresholds were face numbers `[2, 6, 11, 16, 19]`. The engine
  reads thresholds as percentages, so a roll of 4 (20%) was already Legendary. Uplands, a d100
  with `[10, 25, 50, 75, 90]`, was already right.
- "Sail to…" and "set a course for…" were not trips, so a crossing could commit to the ship.
  "Go to the rail" was a trip, so repair invented a place called `marigold-rail`.
- With 6 doubloons left, "forty casks of rum" (12 each) took the last 6 and added no rum. A
  repaired purchase also handed the cask to an NPC.
- A multi-day `clock.advance` was game-breaking, so the move was thrown away with it. The skip
  cap was two days.
- Gold rendered as `doubloons72.00`.
- A turn that started under the cap crossed it on a later call and aborted with `Error:`, so the
  last action never committed.

The validator still does not invent the op. It rejects the turn and tells repair what to write.

## Decisions

### A stat is its id

`stat.add` and `stat.set` accept the id or the label. Case, spaces, and hyphens do not matter.
`Gold`, `crew-morale`, and `Infamy with the Crown` are stored as `gold`, `crew_morale`, and
`reputation_crown`. The state block prints the id beside the label (`Gold [gold]`), which is what
the model copies. The player status line stays the label.

`check.stat` is the same map. A name that matches nothing is `unknown_stat` and fixable, including
a check written as `null`. Pirate `stat_modifier` is off until a book actually has skills. Uplands
was already off. The die math is unchanged.

### The pirate die is a percentage of a d20

Thresholds are `5, 25, 50, 75, 90`. Roll 1 is Catastrophe. The middle of the die is a setback or
a success. Only 19 and 20 are Legendary. Uplands thresholds stay as they are.

### A voyage is a trip. The rail is not

Sail, set a course, weigh anchor, and make port count, including "for". The rail, deck, helm,
hold, cabin, mast, wheel, quay, gangway, and capstan do not: they are a few steps on the place
the player is already in. "Go for a pint" is still not a trip. A voyage that names no existing
place is still create-and-move, or one refusal and then create-and-move.

### A catalog purchase is a whole unit, given to the player

If the narration or the spend reason names a priced item, the delta needs a negative currency
`stat.add` for a whole number of units (at least one) and an `inventory.add` whose owner is the
player. Forty casks is forty times the price. A smaller sum is `underpaid_item` and fixable:
charge the catalog price and add the item, or take the spend back and narrate the refusal. One
unit the player cannot afford is still the existing game-breaking `insufficient_funds`. A negated
verb ("can't buy") does not count. The engine does not invent the op.

### A crossing uses clock.skip

Pirate `max_skip_minutes` is 10080, about a week. `max_per_turn` stays 1440, so one scene cannot
silently become a week. `clock.advance` past the scene cap, but within the skip cap, is fixable
`time_jump`: repair replaces it with `clock.skip` and keeps the move. Past the skip cap it stays
game-breaking. Uplands caps are unchanged. A night's advance on Uplands is now the same fixable
case, because 540 minutes fits that book's skip cap.

### A word is not a symbol

`£` and `GBP` stay `£72.00`. A display with letters is written after the number: `72.00 doubloons`.
A symbol with no letters stays glued to the front.

### The cap stops between turns

Repair, rewrite, format repair, compaction, and the off-screen pass may run after the cap is
crossed, so the turn that started under it can commit. The next player turn, including baseline
and out-of-character, still throws. If that throw reaches the play loop, it prints the same stop
line as the between-turn check. The save stays intact.

## Consequences

- Most of the pirate repairs were the label `Gold`. Those turns now commit on the first draft
  when the rest of the delta is legal.
- A d20 no longer calls a 4 a legend. The narration was already following the printed band, so
  the band had to move.
- A week at sea can be one skip. A month still cannot.
- The overshoot past a cost cap is the rest of the current turn, not an open-ended loop.
- Prompt caching for Haiku is unchanged. The static prefix is still under that model's cache
  minimum, and the prompt is not padded to reach it.
