# ADR 0010: the book seeds the engine

Status: accepted (owner decision, 5 Oct 2026)

## Context

The engine and the game master are one pair for every book. Uplands and the pirate game are two
configs on that pair. A third book, Egypt or a hauler between moons, has to start the same way:
the book is the seed, and neither the engine nor the game master arrives already knowing ships.

ADR 0009 had put the pirate's own words into the shared contract. Every book was told that sailing
counts as a trip and that the rail and the deck are not a new place. That is the book's knowledge,
not the engine's.

## Decisions

### The book names how people move

`config.travel` is three lists:

- `means` are ordinary trips (`walk`, `go`, `leave`, and the rest). "for" does not count, so
  "go for a pint" is still not travel. A book may replace the list.
- `journeys` are the longer ones this world uses. Empty until the book fills them. These also
  allow "for". The pirate book lists sail, set a course, weigh anchor, make port, put in.
  A space book would list jump. An Egyptian book would list its own.
- `local` are a few steps inside the current place. Empty until the book fills them. The pirate
  book lists the rail, the deck, the hold. Without that list, "go to the rail" is a real trip.

The checker and the contract read the same lists. A book that names no journeys and no local steps
gets neither sentence.

### The opening is this book's first chapter

The opening instruction names the book's title and its premise. It does not call every book a life.
The rest of the contract was already built from the config: tone, stats, catalog, time, dice,
violence, and the book's extra rules. The game master sees that on the first call, before the
player types.

### What stays the engine's

Memory, the closed set of ops, and the modules are the same for every book. The book chooses which
modules are on and fills in their numbers. A mechanic that is not a module is not created by
describing it. The wizard, when it exists, emits this config. It does not invent a new kind of stat.

## Consequences

- Pirate crossings still count, because the pirate config says so. Uplands does not grow a deck.
- A new book is a config. Its first turn already speaks its premise and its travel words.
- The words are matched literally. A journey the book forgot to list is not detected, which is the
  same rule as before: the engine does not guess.
