import { describe, expect, it } from 'vitest';
import { defaultAssumptions, sampleHousehold } from '../src/engine/sample';
import { reconcile } from '../src/engine/reconcile';
import { generatePath } from '../src/engine/market';
import { simulate } from '../src/engine/simulate';
import { pathIds, runMonteCarlo } from '../src/engine/montecarlo';
import type { Assumptions, Household } from '../src/engine/types';

const resolutions = { 'oakland.accumulatedDepreciation': 'oak-dep-2024', 'sacramento.loanBalance:sac-heloc': 'sac-heloc-lender' };
const resolved = () => reconcile(sampleHousehold, resolutions).household;
const det = (h: Household, a: Assumptions) => generatePath(a.market, pathIds(h), a.horizonYears * 12, null);

describe('reconciliation', () => {
  it('refuses to proceed while sources disagree, and never averages', () => {
    const r = reconcile(sampleHousehold, {});
    expect(r.conflicts.map((c) => c.key).sort()).toEqual(['oakland.accumulatedDepreciation', 'sacramento.loanBalance:sac-heloc']);
    expect(r.household.properties[0].accumulatedDepreciation).toBeUndefined();
  });
  it('treats agreeing sources as one fact', () => {
    const r = reconcile(sampleHousehold, resolutions);
    expect(r.conflicts).toHaveLength(0);
    expect(r.facts['austin.suspendedLoss'].status).toBe('agreed');
    expect(r.household.properties[1].loans[1].balance).toBe(58_000);
  });
});

describe('sale mechanics', () => {
  const h = resolved();
  const a = { ...defaultAssumptions };
  const sell = simulate(h, a, 'sell', det(h, a), { ledger: true }).transaction!;

  it('gain = amount realized − adjusted basis; §1250 portion = depreciation taken', () => {
    expect(sell.amountRealized).toBeCloseTo(sell.price * 0.94, 6);
    expect(sell.realizedGain).toBeCloseTo(sell.amountRealized - sell.adjustedBasis, 6);
    expect(sell.unrecaptured1250).toBeCloseTo(sell.depreciationTaken, 6);
    expect(sell.capitalGain).toBeCloseTo(sell.realizedGain - sell.depreciationTaken, 6);
  });
  it('releases suspended losses on a fully taxable sale (§469(g))', () => {
    expect(sell.suspendedReleased).toBeGreaterThan(18_000);
  });
  it('tax impact components add up', () => {
    const t = sell.taxImpact;
    expect(t.ordinary + t.recapture1250 + t.capitalGains + t.niit + t.state).toBe(t.total);
    expect(t.recapture1250).toBeGreaterThan(0);
  });
});

describe('1031 exchange mechanics', () => {
  const h = resolved();
  const a = { ...defaultAssumptions };
  const ex = simulate(h, a, 'exchange', det(h, a)).transaction!;

  it('trading up with more debt recognizes no gain', () => {
    expect(ex.boot).toBe(0);
    expect(ex.recognizedGain).toBe(0);
    expect(ex.taxImpact.total).toBe(0);
  });
  it('replacement basis = price − deferred gain; depreciation carries over', () => {
    expect(ex.replacementBasis!).toBeCloseTo(ex.replacementPrice! - ex.deferredGain!, 6);
    expect(ex.suspendedCarried).toBeGreaterThan(0);
    expect(ex.carryoverDepreciableBasis! + ex.excessDepreciableBasis!).toBeCloseTo(ex.replacementBasis! * 0.75, 4);
  });
  it('an all-cash replacement creates mortgage boot that is taxed', () => {
    const allCash = { ...a, replacement: { ...a.replacement, ltv: 0 } };
    const t = simulate(h, allCash, 'exchange', det(h, allCash)).transaction!;
    expect(t.boot).toBeCloseTo(t.loanPayoff, 6);
    expect(t.recognizedGain).toBeCloseTo(t.loanPayoff, 6);
    expect(t.taxImpact.total).toBeGreaterThan(0);
  });
});

describe('loss property', () => {
  it('selling a property below basis produces an ordinary §1231 loss and a tax refund', () => {
    const h = resolved();
    const a = { ...defaultAssumptions, subjectId: 'austin', decisionYear: 1 };
    const t = simulate(h, a, 'sell', det(h, a)).transaction!;
    expect(t.realizedGain).toBeLessThan(0);
    expect(t.ordinaryLoss).toBeLessThan(0);
    expect(t.taxImpact.total).toBeLessThan(0);
  });
});

describe('determinism', () => {
  it('same seed, same answer', () => {
    const h = resolved();
    const a = { ...defaultAssumptions, horizonYears: 10 };
    const x = runMonteCarlo(h, a, 20, 7);
    const y = runMonteCarlo(h, a, 20, 7);
    expect(x.bands.exchange.heirs.p50).toEqual(y.bands.exchange.heirs.p50);
  });
  it('hold and sell are identical before the decision year', () => {
    const h = resolved();
    const a = { ...defaultAssumptions, decisionYear: 3 };
    const p = det(h, a);
    const hold = simulate(h, a, 'hold', p).points;
    const sell = simulate(h, a, 'sell', p).points;
    expect(sell[2].heirs).toBeCloseTo(hold[2].heirs, 6);
  });
});
