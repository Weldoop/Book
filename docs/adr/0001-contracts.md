# ADR 0001: Phase 0 contracts

Status: accepted by owner on 4 Oct 2026 (as part of approving `docs/ARCHITECTURE.md`).

## Decision

`packages/schema` holds all cross-track contracts as Zod schemas and TypeScript interfaces:

- `Config` (game definition) and `State` (one save).
- `Op` closed set of state-change operations and `TurnDraft` (model output).
- `Module` interface implemented by every mechanic, including `core`.
- `LLMProvider`, `LLMRequest`, `LLMResponse`, `LLMUsage`.
- `Store`, `TurnRecord`, `TurnCommit`.

## Rules

- Ops are a closed, versioned set. Adding an op is a contract change.
- State is plain JSON. Module state lives under `state.modules[moduleId]`.
- Time is a local timestamp string (`YYYY-MM-DDTHH:mm`), no timezone.
- Ids are lowercase `[a-z0-9_.-]`.
- Rejected drafts are logged in `TurnRecord.attempts` only. They never enter `state.window`, `state.beats` or `state.summaries`.

## Consequences

Tracks B, C and D can work in parallel against these types and the mock provider.
