# ADR 0003: format_repair attempt kind, thinking off by default

Status: accepted (found in live play, save `live-3`)

## Context

Real-model play showed two failures that the mock never produced:

1. The model sometimes answered in tool-call XML instead of JSON. We treated unparseable output as `game_breaking`, which showed a GM interlude and ran a full strong-tier rewrite. The story was never wrong, only the wrapper.
2. Hidden reasoning tokens counted against `max_tokens` (700). Replies were truncated or empty and the turn rolled back after three attempts.

## Decision

- `Attempt.kind` gains `"format_repair"` (contract addition in `packages/schema/src/store.ts`).
- `unparseable` is severity `fixable`. The first repair reformats the raw text into JSON on the cheap tier. If the raw text is empty, the original request is retried on the strong tier. No interlude is shown for format failures.
- The Anthropic provider sends `thinking: {type: "disabled"}` by default (`BOOK_THINKING=on` to opt in). If the API returns 400 mentioning "thinking", it retries without the parameter and remembers.
- `TURN_MAX_TOKENS` is raised from 700 to 1000 as headroom.
