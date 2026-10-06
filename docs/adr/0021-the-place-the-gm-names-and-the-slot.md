# ADR 0021: the place the GM names, a clock that can go back, and a slot for each person

Status: accepted (owner decision, 6 Oct 2026)

## Context

ADR 0020 caught a move by looking for a travel verb in the narration. A room the prose entered
without one of those verbs was missed, and the status line stayed behind. The clock could not be
set earlier, which leaves no way to write a book where time runs backward. A first draft could say
a thing cost nothing and still charge it. Scheduled events named `dai`, so a new story that changed
the cast left the calendar pointing at someone who was no longer in the save.

## Decisions

### The GM sets the place, and the engine moves the player this turn

`at` is the place id where the player is when the turn ends. The engine creates that place when the
save does not have it, and moves the player there in the same turn. The narration's verbs are not
read for this. A place the player asked for still has to be that `at`. A person, and the vague
words town, outside, upstairs, downstairs, inside, and home, are still not destinations unless the
book names that place.

### The clock may be set earlier

`clock.set` takes an exact local time. It may be earlier than now, so a time-travel book can go
backward. A stated clock time still has to be the time the clock shows. A forward step inside the
cap stays `clock.advance`. Anything else, including a time already past, is `clock.set`.

### A cost of nothing is not a charge

When the narration says the thing cost nothing, a negative currency `stat.add` is rejected. A
repair that copies the charge has it removed. The balance the engine keeps is the one the narration
stated.

### A person keeps a slot id, and the name changes with the story

Uplands housemates are ids `1`, `2`, `3`, and `4`. Scheduled events, threads, and relationships use
those ids. Each new save assigns names from `opening.cast`, so two stories do not share a name. A
person listed in `opening.pinned` keeps the name in the book. The first unpinned person starts in
the player's room. A book with no cast pool is unchanged.

## Consequences

A move the GM does not put in `at` is not inferred from the sentence. The calendar still fires for
slot `1` after the name has changed. The contract stays under 1,800 tokens.
