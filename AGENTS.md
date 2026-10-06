# AGENTS.md

Shared rules for every agent working in this repository. Read `docs/ARCHITECTURE.md` first. It is the source of truth.

## What this project is

A universal AI story engine. A game config picks composable modules. Code owns the truth (clock, stats, inventory, schedules, validation). One strong-model call per turn writes narration plus a structured state change. Nothing is shown to the player until it passes validation and is committed.

## Hard rules

1. The model never writes state. It proposes a `delta`; code validates and applies it.
2. Nothing unvalidated is ever shown to the player or stored in the visible transcript, memory, beats or summaries.
3. Per-turn context has a hard token budget (see `docs/ARCHITECTURE.md` section 6). Do not grow it silently.
4. Contracts live in `packages/schema`. Do not change them without an ADR in `docs/adr/` and owner approval.
5. Stay inside your track's directories (below). If you need a contract change, stop and report it.
6. No new runtime dependencies without owner approval. Dev dependencies only if essential.
7. Never use a real model API in tests or default CI. Use the mock provider. Real-model runs are manual and token-capped.
8. Never commit secrets. API keys come from environment variables (`ANTHROPIC_API_KEY`).
9. Pure functions in `engine`, `modules`, `context`. No I/O there.

## Tracks and ownership

| Track | Owns |
|---|---|
| A. Contracts and engine | `packages/schema`, `packages/engine`, `packages/modules`, `packages/runtime` |
| B. Context and memory | `packages/context` |
| C. LLM, store and harness | `packages/llm`, `packages/store`, `packages/harness` |
| D. Content and evaluation | `configs/`, `fixtures/` |

## Commands

```bash
pnpm install
pnpm typecheck          # tsc across all packages
pnpm test               # vitest, mock provider only
pnpm check              # both
pnpm book <command>     # harness CLI (play, replay, baseline, report)
```

## Code style

- TypeScript strict, ESM, `.ts` import suffixes.
- Small files, explicit types on exported functions, no default exports.
- Comments only for non-obvious intent or constraints.
- Every exported function gets unit tests under `packages/<name>/test/`.

## Definition of done

- `pnpm typecheck` and `pnpm test` pass.
- New behaviour has tests, including failure paths.
- If it affects tokens, latency, repair rate or recall, say which metric and attach harness output.
