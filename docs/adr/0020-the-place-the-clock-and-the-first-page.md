# ADR 0020: the place, the clock, and the first page

Status: accepted (owner decision, 6 Oct 2026)

## Context

A sixty-cent Uplands week committed 72 turns with no rollbacks. The shop total matched. The status
line still drifted from the paragraph. The model walked into a room and forgot `entity.move`. It
wrote 09:47 and advanced the clock to the afternoon. A repair then charged £1.30 for milk the
sentence said was already in the fridge. The opening failed, so the player saw "Type your first
action". No scene ever closed, so four days were one untitled scene. New names such as Seren were
easy to miss, and the next turn had no mark telling the model to create them.

The die stays hidden. Luck wording is left for later.

## Decisions

### The narration's place is a move, and a missing place is created

When the player asks to go somewhere, that place is still the destination. When the narration
itself walks them somewhere ("you head into the kitchen"), that place is a destination too.
Someone else's trip ("Dai heads to the pub") is not. If the place is not in the save, the reply
must `entity.create` it, `entity.move` the player, and set `at`. The engine still does not invent
the move.

### A stated clock time is the clock

A time written with a colon is the time the clock must show after the delta. The violation names
the exact minutes from the clock before the turn. "Alarm for 08:00" is a plan, not the present. A
price written as £2.50 is not a time. If the model is vague ("later", "just past ten"), the
contract tells it to give the engine an exact number of minutes. The clock does not run backwards.

### A repair may not invent a charge

A delta repair may fix a move or a clock. A negative currency `stat.add` that the original delta
did not contain, and that the narration does not state, is dropped before the repaired delta is
checked. The first draft can still charge a figure it also calls free. That contradiction is the
model's sentence, and the contract tells it to charge only a stated figure.

### The first page is always a scene

When the book deals an opening, a failed model reply no longer returns the instruction line. The
save keeps people listed in `opening.pinned`. Everyone else in the seed is replaced. If the model
opening cannot be accepted, the book picks three people from `opening.cast`, using the save id so
two games differ. One is in the room and may be named. The others are unmet and are not named. The
player reads that scene. A book with no opening still starts from its premise, without "Type your
first action".

### A closed scene is a chapter

`scene_ended` takes a short `chapter_title`. If the model forgets the title, it is the beat. The
console prints a break the player can see: the chapter number, the title, and the invitation to
go on. The engine still does not close a scene on its own.

### Four new names, in bold

A turn may mark up to four phrases that appear in the narration and are not already people,
places, or items in the save. The model's list comes first. A proper noun in the middle of a
sentence fills any room left. The player sees them bold, and yellow when the console has colour.
LAST TURNS shows the same phrases in `**bold**`, and the contract says to create them before a
later turn relies on them.

## Consequences

The status line still comes only from ops the model proposed and the engine accepted. A room the
narration enters without a travel verb ("you settle in the living room") is still the model's
`at` to set; the check does not guess it. Uplands pins nobody, so a failed opening replaces Dai,
Cerys, Marcus, and Mrs Pugh, while the calendar events that name them still exist. The contract
stays under 1,800 tokens.
