# ADR 0022: what the seventy-cent session taught the validators

Status: accepted (owner decision, 6 Oct 2026)

## Context

A 69-turn Uplands session on Haiku 4.5 cost $0.70. Forty-seven turns were clean. Six were rolled
back and three rewritten, and almost every one of those was a validator reading the prose wrong
rather than the model breaking a rule: "walk back to the house with Tomos" was a trip to a place
called "house with tomos"; "sent at 08:47" and a text saying "Tuesday 14:30" were read as the clock;
"suggest we go to the pub" moved the player to a pub nobody went to; "buy milk and a loaf" failed
three times because loaf is not on the sheet; eating chips the bag never held became a refusal.
The model also wrote `tomos-reed` for slot `1` and the repair created a second Tomos, invented the
thread kind `potential`, never resolved a thread, and bolded "Alright" and "Yeah" because they were
capitalised. Chapter summaries lost the weekday, and the GM believed them. Energy stayed at 100
across two days of cleaning. No call got a prompt cache read.

## Decisions

### The validators read less of the prose, and read it better

A destination ends where the company, the time, or the errand starts: "the house with Tomos" is the
house, "bed around eleven" is bed. A line that floats the trip as an idea ("suggest", "fancy",
"shall we", "ask if") is not a trip. A clock time inside quotation marks, after "sent" or
"timestamped", in a sentence about tomorrow, a weekday, an interview, or a message, is not the
scene's clock. "Six o'clock", "half seven", and "quarter to nine" are clock times; the reading
nearer the current clock decides morning or afternoon when the sentence does not.

### A deterministic pass tidies the draft before validation

`normalizeDraft` runs ahead of `materializeAt` in both validation and application. It maps an id
the model wrote for someone already in the save (`tomos-reed`, `tomos`) onto that entity, turning a
duplicate `entity.create` into facts on the existing person. A thread kind the schema does not know
becomes `goal`, and `potential` as a kind becomes the scale. A `thread.open` that repeats an open
thread becomes contact with that thread. An adopt or resolve of a thread id that does not exist is
dropped. A bought good that is not on the sheet keeps its charge and loses its bag op. Eating or
handing over a good the bag never held is narration. When the GM leaves `at` out and the sentence
names exactly one known place after "in", "to", or "at", that place is `at`; two named places, or a
place only talked about, infer nothing.

### Threads close without the GM asking

Paying for the matter a thread is about resolves it: a negative currency `stat.add` whose reason
shares two content words with an open thread. An overdue thread's due item now says to
`thread.resolve` it when the story already settled it, and a thread resolved in that turn is not
marked failed.

### Memory carries the date

Each beat records the clock. The archivist sees `t12 Sat 14:10: ...` and the current clock, and
every chapter summary is prefixed with the range it covers, written by code from the clock.

### Energy moves with the clock

A bounded stat may declare `per_hour` and `per_skip_hour`. Hours of `clock.advance` drain it; hours
of `clock.skip` restore it. A turn where the GM already credited the stat was rest and is not
drained. Uplands energy is -4 an hour awake and +12 an hour asleep.

### Highlights are names

A listed phrase must appear capitalised where a capital means a name: mid-clause, or opening a
plain sentence. A word that opens a quotation or a dash clause, runs into punctuation, or is a
contraction is not a name. Each word of a known name is known, so "Tomos" is plain when "Tomos
Reed" is in the save. "Owen's" is Owen. Bold is applied in one pass so a name is never wrapped twice.

### The cache floor is reported

Haiku 4.5 caches nothing under a 4,096-token prefix; Sonnet 4.x caches from 1,024. The contract is
kept under 1,800 tokens on purpose, so on Haiku the static blocks are billed in full every turn.
The play CLI says so once at the end of a session that got no cache reads. The prefix is not padded
to reach the floor.

## Consequences

Three of the six rollbacks and both backward clock jumps in the session do not happen. A second
Tomos cannot be created. A thread the player paid off leaves the prompt. Chapter summaries cannot
drift a day. The contract is unchanged in size. The normalize pass still does not invent a change
from a verb: it maps names, fills defaults, drops ops about untracked goods, and reads the place a
sentence sits in.
