# ADR 0008: the narration has to match the book

Status: accepted (owner decisions after the second Uplands playtest, 4 Oct 2026)

## Context

The world sheet and the dealt opening (ADR 0007) kept the status line honest when the model
remembered to move the player, and the wallet maths was right when it remembered to charge. A
second evening, 109 turns, showed the holes that a legal op can still leave:

- The narration sat the player on a bench by the water, and `entity.move` targeted the house.
  A walk to the cashpoint was told in prose and never written as a move. A legal move to the
  wrong place passes a validator that only checks the op.
- Two pints were ordered in the narration and the delta was empty, so they were free. Oat milk
  stayed in the inventory after the story put it in the fridge.
- The first "you are not leaving the kitchen" was the right refusal. The sixth was the game
  trapping the player.
- The chapter summary still said the budget was £45, and it recorded "weldo" as a running joke
  nobody had said. The archivist never saw the live money, and it had been told to keep nicknames.
- The mobile-plan deadline existed twice: a model thread and a calendar thread with the same matter.

A second model that reads the prose and guesses the ops was rejected. One call proposes the turn.
The check rejects. Repair fills in the move or the price.

## Decisions

### Where the narration stops

`TurnDraft.at` is an optional place id. When the model sets it, that id has to exist, be a place,
and be the player's location after the delta (`location_mismatch`, fixable). A missing `at` is not
a violation. Delta repair returns a delta and a beat, so it cannot add the field; requiring `at`
on every trip would force a rewrite on turns the move alone can fix.

### A trip ends where the player asked to go

The engine parses a destination from the player's input. It does not infer an op from the
narration. If the reply is not a refusal, the place the player ends in has to match that
destination by name, alias, or id (`arrived_elsewhere`, fixable), unless that place was
`entity.create`d in the same delta. A short stem counts when the rest is a place ending, so bed
matches a bedroom and sea matches a seafront. "The nearest shop" may become a new Sainsbury's. A
move to an existing house while the player asked for the seafront may not.

A refusal is allowed once. If the previous turn was also a refused trip, the next refusal is
`trip_insisted` and game-breaking, so the rewrite has to change the narration and move the player.
Delta repair must not leave "you are still in the kitchen" in the prose while the state walks out.

The contract says the same thing: refuse once, with a reason; the second ask creates the place if
needed and moves them.

### A catalog item that changes hands is an op

If the narration mentions a catalog item within a short span after a buy, pay, or order verb, the
delta needs a negative currency `stat.add` and an `inventory.add` of that id (`unpaid_item`,
fixable). If it mentions one after an eat, drink, or put-down verb and the player still carries
it, the delta needs `inventory.remove` (`item_still_held`, fixable). The verb has to sit just
before the mention, and a negated verb ("can't buy") does not count. The engine does not invent
the op. Repair adds it, or the narration has to stop claiming it happened.

### The archivist does not keep the books

The compaction request starts with a state block written by code: the player's location and each
module snapshot, which includes the live money. The archivist is told never to write live money,
health, energy, or the clock, and not to copy a stale balance out of the previous summary. A
nickname counts only when a beat used it. It still does not set location or money. Those stay ops.

### One open thread per matter

`thread.open` is rejected (`duplicate_thread`, fixable) when an open thread already shares four
content words, or shares two and the same deadline. Sharing a minute is not enough on its own.
A scheduled event whose thread repeats an open one is not copied in. Resolved threads do not block
a later matter.

## Consequences

- Repair can fix a wrong move or a missing price without a second strong call. A second refusal
  cannot, because the prose itself is the bug.
- The checks are narrow on purpose. A trip the parser does not recognise, or an item named in a
  way that matches no catalog phrase, is not caught. That is the same rule as before: unstated
  changes did not happen, and the status line stays on the save.
- The archivist can still mention an old goal ("forty-five pounds has to last"). It is told that
  the goal is not the balance. The state block is what a later summary is measured against.
- No new runtime dependency. The mock moves the player when the world sheet has a place that
  matches the input, so a scripted "Go to the kitchen" still commits.
