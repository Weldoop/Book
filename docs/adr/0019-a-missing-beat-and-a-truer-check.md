# ADR 0019: a missing beat, and a truer check

Status: accepted (owner decision, 6 Oct 2026)

## Context

A fresh Uplands week on Haiku rolled back 11 of 103 story calls, and rewrote 14 more. 36 of the
first replies were already one JSON object with narration and a delta. They had no `beat`. Filling
that line was a model call, and it used the first of the two repairs, so the real mistake was
rewritten by the strong model.

The checks also rejected sentences that had already done the right thing. "Walk back to the house
and go into the kitchen" was heard as a trip to the house, because the place pattern swallowed the
rest of the sentence. "Go to sleep" was heard as a place named sleep. "Quiet corner" matched the
phone, "coffee table" matched a takeaway coffee, and "pay from your wallet" looked like buying the
wallet the player was already carrying. "Drink" in the menu line above a cob counted as drinking
the cob. A price written as £2.50 was read as a quantity of 50. A thread that said Friday and was
dated Tuesday was told only to "set due to that weekday", and the repair changed the clock time.

## Decisions

### A missing beat is filled in code

When the reply is one JSON object with narration, and the delta is an array or absent, a blank
`beat` is the first sentence of the narration. A `focus_next` that is a sentence rather than a list
of ids is dropped. Neither counts as a repair, and neither spends a call. Broken JSON still goes to
the format repair. The two-repair limit stays. The engine still does not invent a move, and money
is still a whole catalog price plus `inventory.add`.

### The last place in the sentence is the destination

A place name stops at "and", "then", a comma, or the next clause, and the scan continues. The last
place is the one that counts. "Go to sleep", "go to rest", and "go to nap" are not trips. "Go to
bed" still is, once a bed exists.

### An item is named by its own words

A unique last word counts when the word beside it belongs to that item, or is only "the" or "a".
"Cracked corner" is the phone. "Quiet corner" is not. "Coffee table" is not a takeaway coffee.
"The cob" still is the sausage cob. Gear the player is already carrying is not a new sale. Eat,
drink, and hand over count when that verb is in the same sentence and next to the item. A decimal
price is not a count.

### The weekday error names the date

A thread that names a weekday still has to fall on that weekday. The message gives the next date
that is that weekday, taken from the story clock, so the repair can change the due date.

## Consequences

A reply that only forgot `beat` stays one call, and its delta is the one the model wrote. A kitchen
sentence, a night's sleep, and a sandwich paid for at the catalog price can commit. The contract
does not grow. The player still sees "Nothing quite lands" when a turn is thrown away.
