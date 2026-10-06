# ADR 0007: a world sheet, a dealt opening, and a chapter write that can fail

Status: accepted (owner decisions after the Uplands playtest, 4 Oct 2026)

## Context

A Saturday in Uplands was engaging and then untrustworthy. The status line stayed in the kitchen
while the story went to the prom and the pub, because the narration left the room without an
`entity.move`. Item ids were invented (`gardening-gloves`) and the repair repeated them. From the
beat ceiling onward, every turn waited on a chapter write that came back at the output cap,
failed to parse, and was thrown away, so `story_so_far` stayed empty while the player sat through
it. The same weekend, the same housemates and the same garden job would open every new save.

The validator already applies legal ops. It does not read the narration and invent the op that
should have been there. Location, like money, changes only when a checked op says so.

## Decisions

### The world sheet

Every turn prompt, and every delta repair, carries a world sheet: catalog item ids and prices,
place ids (the player's place first, then places not yet visited, capped at 24), and people tagged
`unmet`. Budget `world_sheet` is 350 tokens. The static contract is unchanged in size class; the
sheet is a few hundred tokens on a prompt that was already under 5k, and after the first turn it
is cache-read.

`entity.create` may set `tags`. `unvisited` marks a place someone has mentioned and the player has
not entered. `unmet` marks a person the player has not met. `syncPresence` clears `unvisited` when
the player is there, and clears `unmet` when that person shares the player's location. Attention
and the scene roster skip `unmet` people unless the player's own input names them. The contract
forbids naming them before that.

If the player tries to go somewhere new, the GM may refuse. If the GM allows it, the same delta
creates the place or clears the tag and `entity.move`s the player. A turn whose prose leaves the
room without that move is rejected; repair has to return the move. The archivist still only writes
the chapter. It does not set location.

Item ops against a non-empty catalog must use a catalog id (`unknown_item`, fixable). Relationship
numbers stay in the GM's state snapshot and off the player panel. Uplands adds `energy` to the
status line. Stress and jeopardy stay hidden.

Conditional events and overdue promises are printed by the engine under the narration
(`playerNotices`). The model may also mention them. Scheduled colour is not printed twice.

### Each save deals its own first chapter

`config.opening` marks a book whose new save should not replay the seeded cast. `dealt_by` is
reserved for a future wizard card and stays unset: the GM deals the cast. There is no player
interview.

`openBook` runs on the play path only, after `newGame`, and only at turn 0. It works on a copy:
seeded people other than the player, their relationships, their inventories and the seeded threads
are removed. Places, factions and the player's own things stay. The model returns a normal draft.
One rewrite is allowed. The draft is validated like any other turn. People not in the room are
created with `unmet`, and an opening narration that names them is rejected. A failed opening
commits nothing, so the seed is still there and play can start. Generated people and threads live
only in the save. They are never written back into the config. The same flag is set on Uplands and
on the pirate book. The premise describes a life, or a voyage, whose first trouble is this chapter.

`newGame`, replay and the golden session do not call `openBook`. Tests that load the config and
play turns keep the deterministic seed.

### The chapter write is off the reading path

`scene_ended` stays the GM's decision. The engine does not infer a close from sleep or travel.
`max_beats` still compacts, and that compaction does not pretend the scene ended.

The validated narration, the engine notices and the status line are handed to the player before
the archivist runs. The turn is then committed once, including the chapter write when it succeeds.
Unvalidated prose is still never shown.

A chapter write that cannot be parsed, or that throws, sets `summaries.compaction_hold_until` five
turns ahead. Until that turn, the beat ceiling does not retry. A scene the GM actually closed
still compacts. The archivist's output cap is 1600 tokens, above the 80-word chapter and 160-word
story it is asked for, so a truncated reply is not the normal case.

Other people know only what they have seen, heard, or been told. An intention that exists only in
the typed command is invisible to them until the player acts on it or says it. There is no
knowledge store.

## Consequences

- The context budget target moves from about 4.5k to about 4.9k. It stays under 5k.
- A crash during the chapter write can lose a turn the player has already read. The alternative
  was making them wait on a call that does not change the page.
- If the player sends the next action before that write finishes, the following turn leans on
  beats rather than the new summary. The CLI does not ask for the next line until the write has
  finished or been held.
- Opening costs one strong call before the first prompt, and a second if the first draft is
  illegal. A failure is silent and the seeded chapter remains.
- Default models are `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`. `claude-sonnet-4-5`
  no longer resolves on the current key. Prices are unchanged ($3/$15 and $1/$5).
