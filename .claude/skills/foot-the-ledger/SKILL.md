---
name: foot-the-ledger
description: Verify a tax or ledger change in hold-sell-exchange by proving every displayed total equals the sum of its displayed lines, to the dollar, and that determinism still holds. Use after any edit to src/engine/tax.ts, simulate.ts, depreciation.ts, or loans.ts.
---

# Foot the ledger

Use this after any change to the engine that can move a dollar amount.

## Steps

1. Run `npm test`. If anything fails, stop and report the failing test name and the expected
   versus received dollar amounts. Do not update an expectation to make it pass.
2. Run `npm run typecheck`.
3. For the change you made, identify every ledger total it touches (`incomeTax`, `niit`,
   `total`, the transaction tax impact, replacement basis, recognized gain). For each one,
   write or extend a test that asserts `total === sum(rounded components)`.
4. If the change touches `market.ts`, `montecarlo.ts`, or any PRNG use, run the
   `determinism` tests twice and confirm the same seed gives identical output.
5. If the change adds a ledger line, confirm `brief.ts` names it; the advisor narrative is a
   template over the ledger and must not have unlabelled lines.
6. Report: the test summary line, which invariants in `CLAUDE.md` you checked, and any
   expected value that changed with the cited source for the new value.

## Do not

- Sum raw floats and round the total.
- Introduce an average, median, or "latest wins" rule into `reconcile.ts`.
- Add a dependency to do any of the above.
