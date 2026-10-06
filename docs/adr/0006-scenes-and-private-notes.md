# ADR 0006: compaction waits for a scene to close; the GM keeps private notes

Status: accepted (owner decisions, 4 Oct 2026)

## Context

Two problems, one answer.

**Compaction had no idea where it was.** `shouldCompact` fired on a flat count of 20 beats since the
last compaction. Nothing about that number knows whether the player is mid-conversation. Two things
went wrong when it landed badly: the chapter summary was cut through the middle of a scene, so a
"chapter" in long-term memory could begin halfway through an argument and end halfway through the
next one; and `applyCompaction` trimmed the verbatim window to the last 6 turns, which could remove
the opening of a scene the GM was still narrating. The second is the one a player would feel - the
GM forgetting who walked into the room two turns ago.

Open decision 30 in the architecture recorded this as unresolved, pending evidence that it actually
happens. It does not need measuring: the trigger is a turn count and scenes are not a fixed number
of turns, so a mid-scene cut is guaranteed eventually rather than possible.

**The competitor has an affordance we lacked.** Questner's "Moving to a New Stage" button is only
offered when a scene has finished, so the prompt to move on never interrupts anything. Our
equivalent was the `continue` turn kind, which the player had to discover by typing `...`.

Separately, its "Hidden Notes" card is worth copying outright:

> You may keep private notes in the format [HIDDEN: your note] at the end of a reply - secrets the
> player hasn't discovered, an upcoming floor twist, or something to pay off in the next few scenes.
> Keep them short. They are never shown to the player, and you only see them for a few turns, so use
> them for what's coming soon.

It gives the GM somewhere to put intent that is not yet a commitment, which is a real gap: our
threads are promises to the story, and there was no cheaper register than a promise.

## Decisions

### The GM declares the scene; the engine chooses the moment

Whether a scene has closed is a language judgement, so the model makes it. `TurnDraft` gains optional
`scene_ended`, which costs about five output tokens and no extra call.

`State.scene` is `{ index, started_turn, closed }`. `applyDraft` sets `closed` when the GM says so;
`openScene` opens the next one on the player's next input, mirroring how an ending's continuation is
applied lazily. `SCENE` in the context now names the scene and how many turns it has run, so the GM
can judge the question it is being asked.

`config.scenes` holds the thresholds:

| Field | Default | Meaning |
|---|---|---|
| `min_beats` | 8 | A scene close below this is not worth compacting |
| `max_beats` | 20 | Compact regardless, so a GM that never closes a scene cannot grow memory for ever |
| `keep_scene_turns` | 12 | Turns of the live scene kept verbatim when a forced compaction lands mid-scene |

So compaction normally happens in the gap between scenes, where nothing is lost. `max_beats` keeps
the old behaviour as a backstop, and in that forced case `windowKeep` holds the live scene rather
than cutting it. The GM is told the backstop exists, so it has a reason not to hold a scene open for
ever.

The console prints one dim line, `--- the scene closes ---`, only on a turn the GM closed, and stays
quiet when an ending is already doing the talking. That is the "move to the next stage" button in a
CLI: an offer that only appears when it cannot interrupt.

### Private notes, which expire on purpose

`TurnDraft` gains optional `notes`, and `State.notes` holds `{ turn, text }`. They render into a
`## YOUR PRIVATE NOTES` context section, newest first, capped by `notes.max_in_context`, and they
are the one part of the context that is never shown to the player. They do not enter the window, the
beats or the summaries, and compaction never sees them.

The expiry is the design, not a limitation. `notes.ttl_turns` (4) is short, and the contract says
what to do about it: *if one still matters, make it real: open a thread, or add an entity fact. A
note is a reminder to yourself; a thread is a promise to the story.* That gives the GM a cheap place
to park an intention and a clear upgrade path when the intention turns out to matter, which is
exactly the behaviour the competitor's card produces by accident and we can ask for directly.

A note is structured output rather than inline `[HIDDEN: ...]`, because our reply is already JSON and
a field cannot leak into prose. As a safety net, `liftHiddenNotes` strips any `[HIDDEN: ...]` the
model writes into the narration anyway - models trained on other story games do this - and moves it
into `notes` before validation, so it can never reach the transcript.

Notes are off per game with `notes.enabled: false`, which also removes the contract block and the
output key, so a game that does not want them pays nothing.

## Consequences

Contract changes: `TurnDraft.scene_ended`, `TurnDraft.notes`, `State.scene`, `State.notes`,
`Config.scenes`, `Config.notes`, a `notes` entry in the context budget, and `shouldCompact` now takes
the config rather than an options bag.

Context cost on the 125-turn golden session with the mock provider: average input per turn goes from
2,937 to 3,217, up 280. Of the 35k cumulative increase, all but about 800 tokens is in the cacheable
static block, because almost all of it is the two new contract sections. The curve stays flat (3,216
at turn 25, 3,108 at turn 125) and the per-turn figure is still well inside the 5k target. The
contract is now the largest single part of the context and deserves a dedicated trim pass before the
Phase 2 benchmark.

The mock provider never sets `scene_ended`, so the replay still compacts on the `max_beats` backstop
and the model-call count is unchanged at 131. Both behaviours therefore need a real model to
exercise properly: whether the GM closes scenes honestly, and whether it uses notes for payoffs
rather than as a scratchpad. Open decision 30 is now closed.
