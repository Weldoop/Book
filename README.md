# Book

A universal AI story engine (working name: `book`). Code owns the truth; one model call per turn writes the story and proposes state changes; nothing is shown until it passes validation and is committed.

Start with `docs/ARCHITECTURE.md` and `AGENTS.md`.

## Quick start

```bash
pnpm install
pnpm check                      # typecheck + all tests (mock provider only)

# Interactive play on the mock model
pnpm book play --config configs/uk-life/config.json --provider mock

# Replay the 125-message golden session and compare against a naive full-history baseline
pnpm book replay   --config configs/uk-life/config.json --fixture fixtures/golden-sessions/uk-life-01.json \
                   --probes fixtures/golden-sessions/uk-life-01.probes.json --provider mock
pnpm book baseline --config configs/uk-life/config.json --fixture fixtures/golden-sessions/uk-life-01.json --provider mock
pnpm book report .book-data/reports/baseline-uk-life-01-mock.json .book-data/reports/replay-uk-life-01-mock.json
```

Inject faults to exercise the repair flow: `--faults every=7,kind=game_breaking`.

## Real model runs

Store `ANTHROPIC_API_KEY` as a Cursor secret (never commit it or type it into a command). If it is not set, the CLI asks for it with hidden input and does not save it. Real runs need `--provider anthropic` and at least one cap:

```bash
pnpm book replay ... --provider anthropic --max-cost-usd 2
```

Models default to `claude-sonnet-4-5` (strong) and `claude-haiku-4-5` (cheap); override with `BOOK_MODEL_STRONG` and `BOOK_MODEL_CHEAP`.

## Layout

| Path | Purpose |
|---|---|
| `packages/schema` | Contracts: config, state, ops, module/LLM/store interfaces |
| `packages/engine` | Pure core: clock, RNG, validation, applying drafts |
| `packages/modules` | stats, inventory, relationships, events, dice, offscreen, player view |
| `packages/context` | Budgeted context, attention mapping, memory compaction |
| `packages/runtime` | Turn controller: validate-then-release, repair, rollback |
| `packages/llm` | Mock and Anthropic providers, usage metering, budget caps |
| `packages/store` | Memory and file stores |
| `packages/harness` | CLI: play, replay, baseline, report |
| `configs/` | Game configs (UK life, pirate) |
| `fixtures/` | Golden session and recall probes |
