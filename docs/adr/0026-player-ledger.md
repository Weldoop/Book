# ADR 0026: the engine writes down what the player said

Status: accepted (owner decision, 11 Oct 2026)

## Context

Phase 2 recall was 9 of 16, and one of the passes was `rys` matching inside `Cerys`. The milk
answer had already said "oat milk" and failed only because the same sentence added "not specifically
the Co-op".

The real misses were lines the player had said, which then left the six-turn window and were never
stored: the nickname, Dai doing the bins, the name Nathan, the coffee, and Uplands tavern at 8.
The lines that passed had become threads. A later question cannot recall a fact nobody wrote down.
Pulling facts into the prompt, or asking a second model, does not find it.

The player is also left out of focus, so the name on the save was invisible to an out-of-character
question.

## Decisions

On the turn the player says it, code writes it down. There is no second model call and no embedding.

- "My name's Nathan" and "my names Nathan" set the player's name.
- "It's Weldo", said as a name and not as "it's raining" or "it's only a couple of quid", adds an alias.
- "Dai has already said he's doing the bins" becomes a minor thread.
- "You do owe me a coffee" becomes a debt, owed by the person in the room, or by each of them when
  several are there. A denial ("you don't owe me") is not a debt.
- "Uplands tavern at 8" becomes a minor thread. A time with no place does not.

The scene line always shows the name and aliases (`You: Nathan; aka weldo`), so a question at turn
122 can still see a name from turn 20. Other commitments go in `state.ledger`, capped at six, with
the name and alias lines kept on top of that. The prompt section is 120 tokens. The other part caps
and the six-fact cap do not move. An old save with no ledger still loads.

A recall probe matches whole words only. A sentence that states the fact and then says "not the
Co-op" still passes. A denial fails when it governs the keyword, including "Dai is not coming".

## Consequences

The next measured recall rate should rise on the five lines that were never stored, and the
handshake probe should fail until the story actually names that person. The 6,000-token bar is
unchanged. The new section can spend up to 120 tokens, and the scene line a few more.
