import { describe, expect, it } from 'vitest';
import { federalParams, federalTax, layerTax, passiveAllowance } from '../src/engine/tax';

const base = { unrecaptured1250: 0, capitalGain: 0, netInvestmentIncome: 0, filing: 'mfj' as const, year: 2025, inflation: 0.025 };

describe('federal ordinary brackets (2025, MFJ)', () => {
  it('taxes $200,000 of wages to the dollar', () => {
    // TI = 200,000 − 31,500 = 168,500
    // 10% × 23,850 + 12% × 73,100 + 22% × 71,550 = 2,385 + 8,772 + 15,741 = 26,898
    const r = federalTax({ ...base, ordinaryIncome: 200_000 });
    expect(r.taxableIncome).toBe(168_500);
    expect(r.incomeTax).toBe(26_898);
  });

  it('layerTax over the full table equals bracket sum', () => {
    const p = federalParams(2025, 'mfj', 0);
    expect(layerTax(0, 23_850, p.brackets)).toBeCloseTo(2_385, 6);
    expect(layerTax(0, 96_950, p.brackets)).toBeCloseTo(2_385 + 8_772, 6);
  });
});

describe('capital gain stacking', () => {
  it('fills the 0% LTCG bracket when ordinary income is low', () => {
    // ordinary 31,500 → TI ordinary 0; 60,000 LTCG all under 96,700 → 0%
    const r = federalTax({ ...base, ordinaryIncome: 31_500, capitalGain: 60_000 });
    expect(r.taxCapitalGains).toBe(0);
    expect(r.incomeTax).toBe(0);
  });

  it('caps unrecaptured §1250 gain at 25% and stacks it beneath LTCG', () => {
    // ordinary TI = 500,000 (in the 32% band, top 501,050); 100,000 of §1250 gain
    // §1250: 1,050 at min(32%,25%) + 98,950 at min(35%,25%) = 25,000
    // then 50,000 LTCG from 600,000 → 650,000: 50 at 15% + 49,950 at 20% = 7.5 + 9,990
    const r = federalTax({ ...base, ordinaryIncome: 531_500, unrecaptured1250: 100_000, capitalGain: 50_000 });
    expect(r.ordinaryTaxable).toBe(500_000);
    expect(r.tax1250).toBe(25_000);
    expect(r.taxCapitalGains).toBe(Math.round(7.5 + 9_990));
  });

  it('taxes §1250 gain at ordinary rates when they are below 25%', () => {
    // ordinary TI 50,000; 20,000 §1250 gain sits in 12% band (to 96,950) → 2,400
    const r = federalTax({ ...base, ordinaryIncome: 81_500, unrecaptured1250: 20_000 });
    expect(r.tax1250).toBe(2_400);
  });

  it('never exceeds the regular tax (worksheet line 47)', () => {
    const r = federalTax({ ...base, ordinaryIncome: 128_200, capitalGain: 5_000 });
    expect(r.incomeTax).toBeLessThanOrEqual(r.regularTax);
  });

  it('limits net capital loss against ordinary income to $3,000', () => {
    const a = federalTax({ ...base, ordinaryIncome: 200_000, capitalGain: -50_000 });
    expect(a.agi).toBe(197_000);
  });
});

describe('NIIT', () => {
  it('applies 3.8% to the lesser of NII and MAGI over $250k (not indexed)', () => {
    const r = federalTax({ ...base, ordinaryIncome: 300_000, capitalGain: 100_000, netInvestmentIncome: 100_000, year: 2040 });
    expect(r.params.niitThreshold).toBe(250_000);
    expect(r.niit).toBe(Math.round(0.038 * 100_000));
    const s = federalTax({ ...base, ordinaryIncome: 200_000, capitalGain: 100_000, netInvestmentIncome: 100_000 });
    expect(s.niit).toBe(Math.round(0.038 * 50_000));
  });
});

describe('§469(i) rental loss allowance', () => {
  it('phases out between $100k and $150k MAGI', () => {
    expect(passiveAllowance(90_000)).toBe(25_000);
    expect(passiveAllowance(120_000)).toBe(15_000);
    expect(passiveAllowance(150_000)).toBe(0);
    expect(passiveAllowance(400_000)).toBe(0);
  });
});

describe('bracket indexing', () => {
  it('reproduces 2025 exactly and indexes later years', () => {
    expect(federalParams(2025, 'single', 0.025).brackets[0].upTo).toBe(11_925);
    expect(federalParams(2026, 'mfj', 0.025).brackets[0].upTo).toBe(Math.round((23_850 * 1.025) / 25) * 25);
  });
});
