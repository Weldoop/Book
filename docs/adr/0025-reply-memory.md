# ADR 0025: the engine recalls before the reply

Status: accepted (owner decision, 11 Oct 2026)

## Context

Phase 2 on Sonnet, and a 233-turn phone game of the same book, missed the same kinds of turn.

Recall probes scored 10 of 16, and two of those passes were denials that happened to contain the
keyword ("you don't know", the bins answer that named Dai while refusing him). The nickname was
still in the room at turn 8. That miss was attention, not a fact cap.

A price quote ("in working order, £35–45… maybe £5–10 off") was read as a purchase. The repair
then charged £10 and added a second copy of gear the player already held. The £10 stuck because
the range's end counted as stating the charge.

The Kenwood meetup was marked failed on the turn the player bought the mixer at Singleton Park
gates. The goods had arrived. The offer had simply gone past noon.

One repaired turn used four model calls and committed. Cutting that call would have rolled the
turn back instead. A phone turn billed 1,829 output tokens because a 229-token reply shared the
line with a 1,600-token chapter compaction, not because the reply itself ran past the ceiling.

## Decisions

The output bar moves from 250 to 400 tokens for narration plus the delta. One story reply
hard-stops at 1,000 output tokens, which is already the request ceiling. The fourth call stays:
a rewrite that commits is better than a rollback. The bar for an ordinary turn is still one call,
and at most three including repairs.

Before the single reply, the engine pulls relevant facts out of long memory. A fact that shares
words with the player's line brings that person in even when they are not in the room. On someone
already in focus, facts that share the line, the player's name or aliases, or an open debt or a
promised time jump ahead of colder facts. The six-fact cap and the part caps stay. There is no
embedding and no second model call.

A later fact that tells the same matter at a different place does not sit beside the one already
witnessed. The earlier fact stays. A more important correction replaces it.

A price range does not state a charge. "In working order" is not a purchase. "Both for a tenner",
"give the man ten", and "shake on thirty-eight" still state those amounts. A second charge and a
second copy are dropped when the player already holds the item and the narration is not paying
for another one.

Buying the item a thread names, at the place that thread names, resolves it. Buying it somewhere
else leaves the thread open. An expired offer fails only when the goods never arrive.

A recall probe passes only when the sentence that contains the keyword affirms it. A denial in
that sentence fails the probe.

## Consequences

The next measured recall rate should fall before it rises: denials that used to pass will fail.
The 6,000-token input bar is unchanged, because recalled facts spend the focus budget that colder
facts already had. Haggling still settles. A quote no longer buys the thing it prices. A meetup
kept at the gate is not a miss.
