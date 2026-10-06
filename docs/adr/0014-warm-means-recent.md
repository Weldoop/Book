# ADR 0014: warm means the player dealt with it

Status: accepted (owner decision, 5 Oct 2026)

## Context

A thread went cold because the prompt showed it. The essay was the line the player was living, and three turns at the desk spent its reminders, so the game master stopped seeing it. The inspection, which they had left, stayed visible because its deadline was close.

Warmth had been a reminder budget. The owner means something else by it: warm is a line they dealt with recently. A cold line stays quiet while a housemate is merely home. Standing in a thread's place shows it, and that does not count as doing the thread, so sleeping in a room does not keep refreshing it. A set-aside major is mentioned in the scene where it steps back, then left quiet until the player picks it up or the deadline is close. The deadline still happens.

## Decisions

### Warm is the last twelve hours

`last_interacted_at` is the clock time the player named a person or place on the thread, or the thread was opened or adopted. The thread is warm while that time is inside `threads.rewarm_hours` (12). Showing the thread does not move the time. Standing in its place does not move the time. `threads.max_reminders` is no longer spent. The field stays so older configs still load.

A warm thread stays in the prompt after the player walks away. A cold thread is listed when they are standing in one of its places, when they name someone or some place on it, or when the deadline is inside the same window. A person who is only sharing the room does not bring a cold thread in. A close deadline does not mark the thread warm.

### A set-aside line is mentioned for that scene

Demotion still sets the quiet major back to a minor and flags `was_major`. It records `set_aside_scene` and does not treat the demotion as a fresh interaction. The prompt lists that line for the rest of the scene, marked set aside, including when its people are elsewhere. The contract tells the game master to mention it once in the world. When the scene moves on, the line stays quiet unless the player is in its place, names it, or the deadline is close. Ignoring it still fires the overdue consequence.

## Consequences

The line the player is living stays with the game master. Sleeping in a room no longer protects that room's major from being the quiet one. A set-aside line is offered in the scene it steps back, and then gets out of the way. No new module.
