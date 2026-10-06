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

## Follow-up: assistant prefill (save `live-4`)

Disabling thinking did not reduce output tokens (turn 2: 651 vs 657). The logs showed the real cause: the model wrote the narration twice, once as plain prose and again inside the JSON, so the JSON was truncated mid-`delta`. 7 of 13 turns hit the 1000-token cap. The contract already said "Reply with a single JSON object only. No prose"; the model ignored it.

When `LLMRequest.json` is set, the provider now appends an assistant message containing `{`, so the reply can only continue inside the JSON object, and `parse` puts the brace back. Prefill is skipped when `BOOK_THINKING=on`, since the API forbids both together, and for an empty reply so the empty-text retry path still triggers.

`claude-sonnet-5-5` rejected the prefill with HTTP 400 ("This model does not support assistant message prefill"). The provider now retries without it and remembers, matching the thinking-unsupported fallback. Models that accept prefill still get it; models that do not still get a working turn.

