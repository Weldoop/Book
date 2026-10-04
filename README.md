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

While playing: one line is one turn, end a line with `\` to continue it, `/debug` toggles the context
and repair dump, `/quit` exits. Add `--log-raw` to keep every model reply verbatim in the turn log,
which is what makes format problems diagnosable afterwards.

A story can end. When a configured ending fires, the console prints its closing card; if the ending
offers a way on, the next thing you type picks the story up wherever the config puts you, with the
move, the lost time and the confiscated possessions all applied by code. An ending with no
continuation closes the save.

The GM says when a scene has closed, and the console marks it with a dim `--- the scene closes ---`.
That is also where memory gets compacted, so a chapter summary is never cut through the middle of a
conversation and the live scene is never trimmed out of the recent window. The GM can also keep short
private notes for what it is setting up; they are never shown to you and expire after a few turns, so
anything that still matters has to become a thread. See `docs/adr/0006-scenes-and-private-notes.md`.

```bash
pnpm book inspect --save <name>            # per-turn calls, tokens, cost, latency, rolls, threads shown
pnpm book inspect --save <name> --turn 4   # the full record for one turn
pnpm book models                           # list the model ids your key can reach
```

## Real model runs

Store `ANTHROPIC_API_KEY` as a Cursor secret (never commit it or type it into a command). If it is not set, the CLI asks for it with hidden input and does not save it. Real runs refuse to start without at least one of `--max-cost-usd`, `--max-total-tokens` or `--max-turns`:

```bash
pnpm book play   --config configs/uk-life/config.json --save live-5 \
                 --provider anthropic --max-cost-usd 2 --log-raw
pnpm book replay ... --provider anthropic --max-cost-usd 2
```

When a cap is used up, play stops between turns and says so; the save is intact, so raising the cap
and reusing the same `--save` resumes where you left off.

Models default to `claude-sonnet-4-6` (strong) and `claude-haiku-4-5-20251001` (cheap); override with `BOOK_MODEL_STRONG` and `BOOK_MODEL_CHEAP`. Run `pnpm book models` to see what your key can reach.

Extended thinking is disabled by default: its hidden tokens are billed at the output rate and were
eating the output cap (ADR 0003). Set `BOOK_THINKING=on` to turn it back on and measure the
difference.

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
| `packages/harness` | CLI: play, replay, baseline, report, inspect, models |
| `configs/` | Game configs (UK life, pirate) |
| `fixtures/` | Golden session and recall probes |
