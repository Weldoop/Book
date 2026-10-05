# ADR 0012: major and minor threads

Status: accepted (owner decision, 5 Oct 2026)

## Context

The Monday inspection kept a session worth playing, and the bins and the phone bill came and went
around it. Warm and cold threads already stop a list of promises from filling the prompt. What they
did not say is which promise is the long one, which are the pieces hanging off it, and which are
only an offer the player has not taken up.

The owner asked for that shape, with the scale hidden from the player and visible in debug. The
game master decides when an offer is taken up. Threads carry the people and places they turn on, so
a thread is listed only when that scene is the one being played. Two majors may run. A minor may
grow into the next major. Minors stay open after their major ends. An offer that is never taken up
goes away. The threads dealt at the opening are majors.

## Decisions

### Scale is a field, not a new system

`thread.scale` is `potential`, `minor` or `major`. Kind stays what the thread is (a debt, a promise,
a mystery). `parent` stays how a minor names the thread it came from. The player never sees the
scale. Debug prints it. The out-of-character recall does not.

### The game master decides the latch

`thread.open` may start a thread at any scale. The default is minor. `thread.adopt` raises an offer
to a minor, or a minor to a major. It does not demote. The contract tells the game master to adopt
only when the player's action took the thread up. The engine does not infer a latch from the
narration.

At most `threads.max_majors` (2) majors are open. A third is fixable: keep it a minor, or resolve a
major first. Resolving a major does not close its minors.

### An offer is made once

A potential is offered in the narration of the turn that opens it, and is then left out of the
prompt. It lapses after `threads.potential_hours` (48) if it is still an offer. Lapsing fails it
quietly. It does not fire an overdue consequence.

### The scene decides whether a thread is listed

`entities` holds the people who know the thread and the places it belongs to. The prompt lists a
minor or a major when its deadline is inside `rewarm_hours`, when the player just named one of
those, or when one of them is in the scene and the thread is still warm. A cold thread stays quiet
even if that person is in the room, until the player names them or the deadline comes back. Majors
take the first slots, up to two. The rest of `max_in_context` is for minors.

The opening deals one or two majors, with those people and places on the thread.

## Consequences

A long matter can carry several smaller ones without crowding the prompt, and an ignored offer does
not linger. The prompt gets a few more lines of rules. No new module.
