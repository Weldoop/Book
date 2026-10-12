# ADR 0029: the place the player named

Status: accepted (owner decision, 7 Oct 2026, brought onto the play app 12 Oct 2026)

## Context

The 200-turn branch filled a missing `at` from the one sheet place the player named, turned a
long `clock.advance` into a `clock.skip`, stopped counting a short catalog word inside a longer
good, and answered some out-of-character questions from the save. That branch was never merged
into the Nuxt game. Later decisions already cover the rest of it: ADR 0024 left the per-part
caps where they are and moved the pass line to 6,000 tokens, ADR 0025 recalls facts before the
reply and sets the output bar at 400, and ADR 0026 writes down what the player said.

## Decisions

When `at` is empty, the delta has not already moved the player, the reply is not a refusal, and
the player's order names exactly one place already on the sheet, that id becomes `at`.
`materializeAt` then moves the player. An unknown destination stays a violation. A move or an
`at` already in the draft is left alone. "Do not chase" is not a trip. A tavern and a pub with
the same other name are the same place.

`clock.advance` longer than one scene, and no longer than `time.max_skip_minutes`, is rewritten
to `clock.skip` before validation. A gap past the skip cap is still rejected. A time in front of
an inspection, a lecture, an alarm, or a quiz is not the clock.

A word that is only the tail of one item, and the start of a longer catalog name in the same
phrase, counts as the longer item. When the spend equals a leading run of whole catalog prices
and the later goods were not put in the bag, those later goods are not an underpayment.

An out-of-character question that hits a stored name, a purchase, or a fact is answered from the
save, with no model call. Anything else still goes to the cheap model. The player ledger from
ADR 0026 is part of that read. The part caps do not change.

Reports keep the sum of every call in `output_tokens`. `story_output_tokens` is the committed
story call alone. The output bar stays the one in ADR 0025.

## Consequences

A known place the player ordered is no longer a rollback just because the reply left `at` empty.
A night logged as an advance can commit as a skip. A four-pack is not also a pint. A nickname
already on the save can be answered without another model call. The 6,000-token bar and the
120-token ledger are unchanged.
