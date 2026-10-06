# ADR 0018: a shorter contract, and a room that matches the sentence

Status: accepted (owner decision, 6 Oct 2026)

## Context

A fresh Uplands week on Haiku spent about 3,400 tokens on the system contract every turn, and
repairs were about 30% of turns. The static prefix is already marked for Anthropic's ephemeral
cache, and the save (`ENGINE NOW`, the last six turns) already sits in the user message after it.
Haiku does not cache a prefix under about 4,096 tokens, so the flag did not reduce the bill. Padding
the prefix to clear that minimum would spend more, not less.

The same week left the status bar in the garden while the sentence had gone back to the kitchen.
The player had asked to go there. The narration also said Cerys was "still at the table", and the
travel check treated any "still at" as a refused trip, so the missing `entity.move` was allowed.
A cob the sentence set down stayed in the bag, because "cob" is not the full catalog name and
"set down" was not one of the verbs that means a good has left the hands.

A turn that named `claude-sonnet-4-5` failed on the first call. That id is not a current model.
`claude-3-5-sonnet` and `claude-3-7-sonnet` are not either.

## Decisions

### The contract stays on every call, and it is shorter

The rules, the worked examples, and the Uplands style lines are one cacheable prefix. Uplands
measures about 1,788 tokens, under 1,800. The op signatures stay in that prefix. The turn is still
one JSON object that code validates. Variable state stays after the prefix. The prefix is not padded
to a provider's cache minimum.

### A missing model becomes the tier default

`claude-sonnet-4-5` and the older Sonnet 3.5 and 3.7 ids are sent as `claude-sonnet-4-6`. The older
Haiku ids are sent as `claude-haiku-4-5-20251001`. Any other id the API does not know is tried once
on that tier's default. If that also fails, the player sees "The storyteller is unavailable right
now. Try again in a moment."

### The room in the sentence is the room in the save

"Still at the table" is not a refused trip. "You're still here" and "the garden can wait" still are.
When the player asks to go to the kitchen and the narration arrives there, the delta `entity.move`s
them and sets `at`. The engine does not invent the move. The next turn's `ENGINE NOW` reads the
save that was just written.

### A good that is set down leaves the bag

The last word of a catalog name counts when no other item ends with it, so "cob" is the sausage cob
and "milk" is not, because two items end that way. "Set down" is letting a good go, in the same turn
as eating or handing it over. Gear that is only set down in the room stays. Gear that is handed over
or left at a shop still has to be removed.

### Three offers, and the scene still ends when the story does

A turn may include `suggested_actions`, at most three short strings. The console prints them dimmed
under the status line. They do not choose the player's action. A risky result still uses the fate
die already drawn, and hard work spends energy with `stat.add`. The engine does not roll a second
check or invent the spend. A scene ends when the game master sets `scene_ended`. That is the pause.
There is no chapter break on a turn count.

## Consequences

A clean story call carries a smaller repeated prefix. Haiku will still bill that prefix in full
until it is long enough to cache. Sonnet can cache it. The kitchen line can no longer commit while
the status bar stays in the garden. A cob set down on the table is no longer still being carried.
The player is not shown a raw model error.
