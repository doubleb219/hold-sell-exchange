# Hold / Sell / Exchange — rules for AI-assisted work

This is a tax-exact simulator. The numbers it prints go in front of a client, so every rule
below exists to keep the ledger right to the dollar and explainable line by line. Read
`README.md` first; it describes the engine, the market model, and the deliberate
simplifications. Do not "fix" a simplification that is listed there without being asked.

## Commands

```bash
npm test            # vitest, 31 tests, runs in ~2 s, no network
npm run typecheck   # tsc --noEmit (build runs this too)
npm run dev         # http://localhost:5173/#demo
npm run build       # typecheck + vite build to dist/
```

Run `npm test` and `npm run typecheck` before reporting any engine change as done. Paste the
summary line, not the whole output.

## Layout

- `src/engine/` is pure TypeScript with no UI or browser dependencies. Keep it that way; the
  Web Worker (`src/worker.ts`) and the tests both import it directly.
- `src/ui/` holds hand-written SVG charts. There is no chart library and none should be added.
- `tests/` is vitest. Every engine file has tests that assert exact dollar amounts.

## Engine invariants (do not break these)

1. **Round each line, then sum the rounded lines.** Never sum raw floats and round the total.
   Every total in the ledger (`total`, `incomeTax`, tax impact of a transaction) must equal the
   sum of its displayed components. See the comment in `src/engine/tax.ts` near `incomeTax`.
   The test `tax impact components add up` guards this.
2. **Reconciliation never averages.** When two sources disagree on a fact, the result is a
   `Conflict` and the engine refuses to run until a human picks a source. Do not add a
   "best guess", weighted mean, or "most recent wins" fallback. `AGREEMENT_TOLERANCE` is $1.
3. **Determinism.** The market model uses a seeded PRNG (mulberry32). Same seed, same answer.
   Hold, sell, and exchange must see the same market path (common random numbers). Do not
   call `Math.random()` anywhere in `src/engine/`.
4. **Tax impact of a transaction = tax with it − tax without it**, same household, same year.
   Do not compute it any other way, and do not compute it from a single strategy's ledger.
5. **Depreciation never exceeds basis.** "Allowed or allowable" from the return wins over the
   schedule; absorb the delta in the building tranche (`simulate.ts`, `newTranche`).
6. **Tax tables are cited, not remembered.** Brackets, MACRS percentages (Pub. 946 Table A-6),
   NIIT threshold, the §469(i) phase-out, and the §1250 25% cap each come from a named
   source and have a test that asserts the published figure. Do not update a figure from
   memory; add the citation to the test name or a comment.

## Changing tax logic

- Write the failing test first, with the dollar amount and where it comes from (IRS table,
  worksheet line, or a worked example from the README).
- Add new ledger lines to the `TaxResult` shape and to the narrative in `brief.ts`; the brief
  is a template over the ledger, so an unlabelled line is a bug.
- If a change alters any existing expected dollar amount, say which test changed and why in
  the commit message. A silent expectation update is not acceptable.

## Things not to do

- Do not add dependencies. The runtime dependency list is `react` and `react-dom`.
- Do not add an LLM, API call, or anything nondeterministic to the engine or the brief.
- Do not remove or soften the "Not tax advice" line in the README or the UI.
- Do not commit `dist/`; GitHub Pages builds it in CI (`.github/workflows/deploy.yml`).
- Do not add `Co-Authored-By` trailers to commits.
