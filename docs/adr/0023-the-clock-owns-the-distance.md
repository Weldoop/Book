# ADR 0023: the clock owns the distance, and the contract is measured

Status: accepted (owner decision, 7 Oct 2026)

## Context

Two Haiku sessions after ADR 0022 (44 and 34 turns, $0.37 and $0.27) left three failures the
validators did not see. "The shift at Derek's is still five hours away" at 07:15 for a 17:00 shift;
"the letting agent's coming in a few hours" the day before the inspection. "Go inside" from the
garden and "downstairs to the front room" from the bedroom left the status line where it was,
because inside and front room were not places the book named. Every opening on Haiku put Monday
on a Wednesday and spent a repair call on it.

The owner also asked whether the contract could be generated from the config to save tokens.

## Decisions

### A distance to a deadline is the clock's to state

A sentence that shares two content words with exactly one open thread that has a due date, and
is not inside quotation marks, has its relative time checked against that due date measured from
the clock the delta lands on. "Five hours away" that should be ten becomes "about ten hours away".
"In a few hours" that is tomorrow becomes "tomorrow"; "this afternoon" that is Monday becomes
"on Monday". A count within 45 minutes or 35 percent stands. A passed deadline, a sentence about
no thread or two threads, and quoted speech are left alone.

This is the one place the engine edits prose. The alternative was a strong rewrite call for a
number, and the number is code's. It runs in the tidy pass, before validation, so the window,
the beats, and the player all see the corrected sentence.

### Inside, home, upstairs, and the front room are places the book names

A bare alias after a verb of going ("head inside", "walk home", "run upstairs") names the place
the alias belongs to, as "in the front room" already did. Uplands gains a living room (front room,
common room, lounge) and gives the house the aliases home, inside, indoors, downstairs, the hall,
and the front door; the bedroom gains upstairs. The back garden is no longer inside the house, so
coming in from it is a move. The contract line stands: these are not places unless the sheet
names them, and now the sheet does.

### A named weekday lands on its date before validation

A thread that names one weekday and carries a due date on another weekday gets the next date on
that weekday, at the time the GM wrote. Two weekdays, or no due date, still go to the repair with
the message that names the dates. The opening prompt carries the week ahead ("today 2026-10-03,
tomorrow 2026-10-04, Monday 2026-10-05, ...") so the model stops guessing.

### The contract is config-generated, and measured

The contract was already built from the config: title, tone, premise, player id, travel words,
dice visibility and bands, skip cap and rest note, thread limits and hours, scene size, style,
notes, examples drawn from the catalog, and the op signatures and fragments of the active modules.
Measured for Uplands, in tokens:

| Part | Tokens |
|---|---|
| Header | 104 |
| RULES | 593 |
| TIME | 74 |
| OUTCOMES | 129 |
| THREADS | 200 |
| SCENES | 65 |
| STYLE | 139 |
| NOTES | 39 |
| EXAMPLES | 73 |
| CONTENT | 34 |
| OPS | 224 |
| OUTPUT | 119 |
| Module fragments | 414, now 330 |

Two changes: the inventory and stats fragments no longer repeat the purchase and balance rules
that RULES carries (84 tokens), and a book without a dice block gets no fate-die lines and no
`check` key. The static prefix for Uplands is about 2,120 tokens, 43 percent of a 4.9k turn.

What was not done: a book-level switch to drop rule groups. Each line in RULES came from a logged
failure, and dropping one trades a cached ~15 tokens for a cheap repair call (~3k tokens) when
the model breaks that rule again. A dynamic contract that includes the purchase rules only when a
priced good is in scope would save 100 to 200 tokens on quiet turns at no cache cost on Haiku,
which caches nothing under 4,096 tokens, but it is not measured and is left for the benchmark.

## Consequences

A wrong distance to a deadline is corrected without a call. Inside and home move the player.
The opening no longer spends a repair on the calendar. The prefix is 84 tokens shorter. At the
measured rates a 200-turn Uplands game costs about $1.60 on Haiku 4.5 and about $3.50 to $4.50
on Sonnet 4.6 with the prefix cached, against roughly $6 and $18 for resending the transcript.
