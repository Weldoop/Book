# ADR 0011: the save outranks the last six turns

Status: accepted (owner decision, 5 Oct 2026)

## Context

A one-dollar Uplands session on Haiku reached turn 99. The household and the Monday deadline were
worth playing. The rewinds were not. About a third of drafts did not commit on the first try, and
twelve of them were shown to the player as a pause. The last narration said there was £11 in a
wallet and that the textbook had been left at the shop. The status line said £1.60, and the save
still held the textbook, the cob, and the coffee.

Two mechanisms caused most of that. The verbatim window is the last six turns, and a model trusts
the latest prose more than an earlier state block, so a stale price in that window was retold.
The trip check treated "walk to the corner shop for a sausage" as a destination named "corner shop
for a sausage", which matched no place, so the whole turn rolled back.

Warm and cold threads were doing their job and stay. What was missing was a memory that belongs to
one person: a small slight can fade, and a fight cannot. ADR 0007 said there is no separate
knowledge store. That still holds. A person's facts are the memory.

## Decisions

### The save is labelled factual, after the six turns

`ENGINE NOW` is assembled after `LAST TURNS` and before the player input, and the same block is
given to delta repair. It repeats the player's status line and what they are carrying, with the
place id. The contract says those lines win over the window and over story-so-far. The window stays
six turns. The archivist's state block is unchanged.

The validator still does not invent an op from the narration. Marking the save as fact is how the
narration stops contradicting it.

### A trip is the place, not the errand

The destination is cut at "for" and at a second "to", so "the corner shop for a sausage" and "the
shop to buy milk" are the shop. "Go for a pint" is still not a trip, because ordinary travel does
not use "for". A journey the book listed, such as "sail for the harbour for water", stops at the
harbour. This removes the false rejection. It does not add a move the model forgot to write.

### A repair is not part of the story

The dim line that named `delta_repair`, a rewrite, or a rollback is printed only while debug is on.
The usage line still records the outcome. The in-world interlude and the rollback note stay, and
both books stop naming a game master in them. Warm and cold threads, the two repair attempts, and
the rule that the validator applies legal ops and does not invent them are unchanged.

### A person remembers, and some of it fades

`entity.fact.add` on a person is that person's memory of what they saw, heard, or were told. The
engine sets the lapse from the importance, so the model does not have to name an expiry:

- importance 1, a passing or remedial thing, lapses after a day
- importance 2 lapses after a week
- importance 3, a fight, a betrayal, or real harm, has no lapse

A place does not forget. A fact seeded with the character, which has no expiry, stays. Compaction
keeps an existing lapse and does not make a serious memory temporary. Forgotten facts leave the
save at the end of the turn and are left out of focus before that. Other people still do not know
a thought the player only wrote in the command.

## Consequences

Fewer shop and pub turns should roll back, and the narration has a factual line newer than the
window to copy from. A person who was shoved still knows it a week later; a rude remark about the
bins does not have to. The prompt grows by the status block, which is short and sits in the
uncached tail on purpose, next to the turns it has to outrank. No new module and no new op.
