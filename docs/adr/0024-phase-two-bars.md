# ADR 0024: the phase 2 bars move to 6,000 tokens and a 1% rollback

Status: accepted (owner decision, 11 Oct 2026)

## Context

The phase 2 gate in section 1.2 asked for under 5,000 input tokens at turn 200, and for under
0.5% of turns to roll back. A live Sonnet session of 233 turns on the phone console held the
engine's own context at about 5,170 by the end, flat from the early chapters, with three
rollbacks in 237 model calls (about 1.3%).

The per-part trim caps in section 6 are unchanged. They still sum to about 4,900. This decision
moves the pass line, not the cutter.

## Decisions

Input tokens per turn at turn 200 must stay under 6,000, and flat from about turn 20.

Turns that fail every repair and roll back must stay under 1% of model calls.

## Consequences

A session whose engine context sits between 5,000 and 6,000 meets the token bar. One rollback
in a hundred model calls meets the rollback bar. The 233-turn Sonnet save is inside the token
bar and still over the rollback bar, at about 1.3%.
