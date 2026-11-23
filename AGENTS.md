# Agent instructions

`CLAUDE.md` is the single source of rules for this repository and applies to every coding
agent (Claude Code, Codex, Cursor, Copilot). Read it in full before changing `src/engine/`.

The three rules that matter most, repeated here so they are never skipped:

1. Round each ledger line, then sum the rounded lines. Totals must foot to the dollar.
2. Reconciliation never averages conflicting sources; it stops and asks a human.
3. The engine is deterministic: seeded PRNG only, no `Math.random()`, no network, no LLM.

Verify with `npm test` and `npm run typecheck` before reporting work as done.
