import { describe, expect, it } from 'vitest';
import { annualDepreciation, newTranche, scheduledDepreciation, stepTranche } from '../src/engine/depreciation';
import { annuityPayment, initLoan, stepLoan } from '../src/engine/loans';
import type { Loan } from '../src/engine/types';

const src = { kind: 'lender_statement' as const, document: 'test', asOf: '2026-01-01' };

describe('MACRS 27.5-year mid-month (Pub. 946 Table A-6)', () => {
  it('matches the table for January placement: 3.485% then 3.636%', () => {
    expect(annualDepreciation(100_000, 2025, 1, 2025) / 1000).toBeCloseTo(3.485, 3);
    expect(annualDepreciation(100_000, 2025, 1, 2026) / 1000).toBeCloseTo(3.636, 3);
  });
  it('matches the table for June placement: 1.970% in year one', () => {
    expect(annualDepreciation(100_000, 2025, 6, 2025) / 1000).toBeCloseTo(1.97, 3);
  });
  it('final partial year for January placement is 1.970%, then nothing', () => {
    expect(annualDepreciation(100_000, 2025, 1, 2052) / 1000).toBeCloseTo(1.97, 3);
    expect(annualDepreciation(100_000, 2025, 1, 2053)).toBe(0);
  });
  it('never depreciates more than basis', () => {
    expect(scheduledDepreciation(275_000, 1990, 1, 2030, 12)).toBe(275_000);
  });
  it('half month in placement and disposition months', () => {
    const t = newTranche('x', 330_000, 5);
    expect(stepTranche(t, 5)).toBe(500);
    expect(stepTranche(t, 6)).toBe(1000);
    expect(stepTranche(t, 7, true)).toBe(500);
  });
});

describe('loans', () => {
  it('fixed loan amortizes to zero exactly at term', () => {
    const s = initLoan({ id: 'a', label: 'a', kind: 'fixed', balance: 300_000, rate: 0.06, amortMonthsRemaining: 360, source: src });
    const pmt = annuityPayment(300_000, 0.06, 360);
    expect(pmt).toBeCloseTo(1798.65, 2);
    for (let m = 0; m < 360; m++) stepLoan(s, 0.04);
    expect(s.balance).toBeLessThan(0.01);
  });

  it('interest-only pays no principal, then converts to amortizing', () => {
    const s = initLoan({ id: 'b', label: 'b', kind: 'interest_only', balance: 100_000, rate: 0.06, ioMonthsRemaining: 2, amortMonthsRemaining: 120, source: src });
    expect(stepLoan(s, 0).principal).toBe(0);
    expect(stepLoan(s, 0).principal).toBe(0);
    const third = stepLoan(s, 0);
    expect(third.interest + third.principal).toBeCloseTo(annuityPayment(100_000, 0.06, 120), 6);
  });

  it('ARM resets on schedule and respects periodic and lifetime caps', () => {
    const def: Loan = {
      id: 'c', label: 'c', kind: 'arm', balance: 200_000, rate: 0.0275, amortMonthsRemaining: 300,
      arm: { monthsToReset: 2, resetEveryMonths: 12, margin: 0.0275, periodicCap: 0.02, lifetimeCap: 0.0775, floor: 0.0275 },
      source: src,
    };
    const s = initLoan(def);
    stepLoan(s, 0.08);
    stepLoan(s, 0.08);
    expect(s.rate).toBe(0.0275); // not yet
    stepLoan(s, 0.08); // reset month: index 8% + 2.75% = 10.75% → capped at +2%
    expect(s.rate).toBeCloseTo(0.0475, 10);
    for (let i = 0; i < 12; i++) stepLoan(s, 0.08);
    expect(s.rate).toBeCloseTo(0.0675, 10);
    for (let i = 0; i < 12; i++) stepLoan(s, 0.08);
    expect(s.rate).toBeCloseTo(0.0775, 10); // lifetime cap
  });

  it('HELOC floats monthly with the index and amortizes after the draw period', () => {
    const s = initLoan({ id: 'd', label: 'd', kind: 'heloc', balance: 50_000, rate: 0.08, amortMonthsRemaining: 0, heloc: { drawMonthsRemaining: 1, margin: 0.03, repayMonths: 120 }, source: src });
    const m1 = stepLoan(s, 0.05);
    expect(m1.principal).toBe(0);
    expect(m1.interest).toBeCloseTo((50_000 * 0.08) / 12, 6);
    const m2 = stepLoan(s, 0.04);
    expect(s.rate).toBeCloseTo(0.07, 10);
    expect(m2.principal).toBeGreaterThan(0);
  });

  it('paid-off liens never generate a payment', () => {
    const s = initLoan({ id: 'e', label: 'e', kind: 'fixed', balance: 0, rate: 0.05, amortMonthsRemaining: 0, source: src });
    expect(stepLoan(s, 0.05)).toEqual({ interest: 0, principal: 0 });
  });
});
