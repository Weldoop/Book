# ADR 0015: witnessed memory, and ordinary sentences

Status: accepted (owner decision, 5 Oct 2026)

## Context

Threads keep a promise, and a person's facts keep what that person witnessed. On a long game that is
how an NPC still knows what the player did, and how the save stops a narration from spending money
or leaving a place the player never reached. The contract already said to write `entity.fact.add`.
The worked examples showed a move and a purchase, so a model can play a whole scene and store nothing
for the people who were there.

The same checks that catch a real purchase were also catching ordinary sentences. "Put my phone on
charge" and "left my phone on the side" were read as letting the phone go, because `put`, `leave`
and `left` all counted. "Go in the house to check my phone" was a trip to "check my phone". "Go to
the coop as I leave, say to the lad" took the lad as the place, because `leave` looked ahead for the
next `to`.

## Decisions

### One fact per witness

When someone in the scene sees, hears, or is told something that would change a later scene, the
game master adds one short `entity.fact.add` on that person in the same turn. A passing remark adds
nothing. Importance stays theirs: a passing thing fades after a day, a promise or a favour after a
week, and a fight stays. The narration may say what someone remembers only when that fact is already
on them, or this turn is adding it because they just witnessed it. A turn that says they will
remember, and stores nothing, still stands. Next time, they do not remember. The engine does not
invent the fact, and it does not roll the turn back for a missing one.

### A parked phone is still carried

`put`, `leave` and `left` still mean the item was set down, so the fridge and the shop still need
`inventory.remove`. They do not count when the words just after the item are "on charge", "to
charge", "on the side", or "on the bedside". Eating, drinking, handing over, and giving still count.

### The destination is the place

A trip still has to end where the player asked to go. The clause after `as` is not part of the
place, so "the coop as I leave" is the coop. The word after `to` is not a place when it is the
errand: check, see, say, and the same kind of verb. `leave` is a trip only when the preposition
comes next ("leave to the garden"). "As I leave, say to the lad" does not move the destination.
"Go to the kitchen", "go to the shower", and "go to the shop for a cob" are still trips.

## Consequences

People who were there can still know the promise next week, because the fact is on them when they
come back into the scene. A phone on charge no longer rolls the turn back. A real handover, a real
purchase, and a real departure still have to be in the delta. No new module, and no second memory
store.
