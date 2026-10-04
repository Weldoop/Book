# ADR 0002: optional `onTurnCommitted` module hook

Status: accepted (Track A, within the approved plan).

## Decision

Add an optional `onTurnCommitted(state, config, { due, now })` method to the `Module` interface in `packages/schema`.

## Why

Events need to remember what has already fired and when they were last evaluated. The module that owns that state should update it, so the engine does not have to know about each module's state layout.

## Consequences

Backwards compatible: modules that do not need it simply omit it. No other track depends on it.
