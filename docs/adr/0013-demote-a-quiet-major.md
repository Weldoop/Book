# ADR 0013: demote a quiet major

Status: accepted (owner decision, 5 Oct 2026)

## Context

Two majors can run, and a minor can become the next one. ADR 0012 refused a third: the turn was
fixable, and the new pursuit might not stick. The owner wants the player to be able to take up
another long story line without a lecture and without the story dropping the one they left. Threads
are story lines (a job, the garden, an essay), not kinds of task. Scale is weight.

Leaving the third as a major that merely steps out of the prompt would let majors pile up in the
save, which is the thing the cap is for. Demotion is the other half of promotion.

## Decisions

### A third major sets the quiet one aside

`thread.open` at major, and `thread.adopt` to major, no longer fail when `threads.max_majors` are
already open. The engine demotes the open major the player has left alone: lowest
`last_interacted_turn`, then older `opened_turn`, then id. The new one stays major. The turn commits.

Demotion sets `scale` to minor, `was_major` to true, `warm` to true and `reminders` to 0. It does
not resolve the thread, does not clear `due` or `on_overdue`, and does not change
`last_interacted_turn`. An explicit `thread.adopt` to minor does the same when the thread was a
major. Adopting an offer to a minor does not set `was_major`.

### What counts as having touched it

`last_interacted_turn` is set when the thread opens, when that thread is adopted, when the player's
input names a person or place on it, or when the player is standing in one of its places. Someone
merely sharing the room does not count, and neither does the prompt having shown the thread. The
touch is recorded before the ops of that turn, so naming a major protects it from being the one set
aside.

### The offer comes back, and the deadline still bites

A minor with `was_major` is listed while it is still warm, even when nobody from it is in the scene,
ahead of an ordinary minor. Each showing spends a reminder. After `max_reminders` it goes cold and
leaves the prompt until the player names it or the deadline is close. `overdueThreads` is unchanged:
a demoted line whose `due` has passed still fires `on_overdue` and is then failed.

The game master is told to write the new line as the one being lived, and to mention a set-aside
line in the world so the player can pick it up. The player's page does not announce a demotion.
Scale words stay out of the narration and out of out-of-character recall. Debug shows `set-aside`
or `was-major`.

The opening still deals one or two majors.

## Consequences

A player can start another long story line. The one they have left alone stays in the save, is
offered back a few times, and still has consequences if it is ignored. The prompt does not grow a
third major slot. No new module.
