import type { FilingStatus } from './types';

/**
 * Federal income tax, bracket-exact for tax year 2025 (post-OBBBA standard deduction).
 * Later years index thresholds by an *assumed* inflation rate and round to $25,
 * except the statutory, non-indexed amounts (NIIT thresholds, §469(i) allowance).
 */

export interface Bracket {
  upTo: number;
  rate: number;
}

export const BASE_TAX_YEAR = 2025;

const ORDINARY_2025: Record<FilingStatus, Bracket[]> = {
  mfj: [
    { upTo: 23_850, rate: 0.1 },
    { upTo: 96_950, rate: 0.12 },
    { upTo: 206_700, rate: 0.22 },
    { upTo: 394_600, rate: 0.24 },
    { upTo: 501_050, rate: 0.32 },
    { upTo: 751_600, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
  single: [
    { upTo: 11_925, rate: 0.1 },
    { upTo: 48_475, rate: 0.12 },
    { upTo: 103_350, rate: 0.22 },
    { upTo: 197_300, rate: 0.24 },
    { upTo: 250_525, rate: 0.32 },
    { upTo: 626_350, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
};

/** Taxable-income thresholds where the 0% and 15% long-term capital gain rates end. */
const LTCG_2025: Record<FilingStatus, [number, number]> = {
  mfj: [96_700, 600_050],
  single: [48_350, 533_400],
};

const STANDARD_DEDUCTION_2025: Record<FilingStatus, number> = { mfj: 31_500, single: 15_750 };

export const NIIT_RATE = 0.038;
/** IRC §1411 thresholds are statutory and NOT inflation-indexed. */
export const NIIT_THRESHOLD: Record<FilingStatus, number> = { mfj: 250_000, single: 200_000 };
export const UNRECAPTURED_1250_MAX_RATE = 0.25;
export const CAPITAL_LOSS_LIMIT = 3_000;

export interface FederalParams {
  year: number;
  brackets: Bracket[];
  ltcgZeroTop: number;
  ltcgFifteenTop: number;
  standardDeduction: number;
  niitThreshold: number;
}

function index(x: number, factor: number): number {
  if (factor === 1 || !isFinite(x)) return x;
  return Math.round((x * factor) / 25) * 25;
}

export function federalParams(year: number, filing: FilingStatus, inflation: number): FederalParams {
  const factor = Math.pow(1 + inflation, Math.max(0, year - BASE_TAX_YEAR));
  const [z, f] = LTCG_2025[filing];
  return {
    year,
    brackets: ORDINARY_2025[filing].map((b) => ({ upTo: index(b.upTo, factor), rate: b.rate })),
    ltcgZeroTop: index(z, factor),
    ltcgFifteenTop: index(f, factor),
    standardDeduction: index(STANDARD_DEDUCTION_2025[filing], factor),
    niitThreshold: NIIT_THRESHOLD[filing],
  };
}

/** Tax on the slice of taxable income [lo, hi), with an optional cap on each bracket's rate. */
export function layerTax(lo: number, hi: number, brackets: Bracket[], rateCap = 1): number {
  if (hi <= lo) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    const a = Math.max(lo, prev);
    const z = Math.min(hi, b.upTo);
    if (z > a) tax += (z - a) * Math.min(b.rate, rateCap);
    prev = b.upTo;
    if (prev >= hi) break;
  }
  return tax;
}

function overlap(lo: number, hi: number, a: number, b: number): number {
  return Math.max(0, Math.min(hi, b) - Math.max(lo, a));
}

export interface FederalInput {
  ordinaryIncome: number; // wages, net rental income, §1231 losses, released passive losses
  unrecaptured1250: number; // §1(h)(6) gain, taxed at ordinary rates capped at 25%
  capitalGain: number; // other net long-term capital gain + qualified dividends (may be negative)
  netInvestmentIncome: number;
  filing: FilingStatus;
  year: number;
  inflation: number;
}

export interface FederalResult {
  agi: number;
  taxableIncome: number;
  ordinaryTaxable: number;
  ordinaryTax: number;
  tax1250: number;
  taxCapitalGains: number;
  regularTax: number;
  incomeTax: number;
  niit: number;
  total: number;
  params: FederalParams;
}

/**
 * Stacking follows the Schedule D Tax Worksheet: ordinary income fills the brackets first,
 * unrecaptured §1250 gain stacks next (at min(bracket rate, 25%)), and the remaining
 * long-term gain stacks on top at 0/15/20%. The result is the lesser of that and the
 * regular tax on everything (worksheet line 47).
 */
export function federalTax(i: FederalInput): FederalResult {
  const p = federalParams(i.year, i.filing, i.inflation);

  // Net capital losses first absorb unrecaptured §1250 gain, then up to $3,000 of ordinary income.
  let u = Math.max(0, i.unrecaptured1250);
  let g = i.capitalGain;
  let ordinary = i.ordinaryIncome;
  if (g < 0) {
    const net = u + g;
    u = Math.max(0, net);
    g = 0;
    if (net < 0) ordinary += Math.max(net, -CAPITAL_LOSS_LIMIT);
  }

  const agi = ordinary + u + g;
  const ti = Math.max(0, agi - p.standardDeduction);
  const preferential = Math.min(u + g, ti);
  const ordTI = ti - preferential;
  const uPart = Math.min(u, preferential);
  const gPart = preferential - uPart;

  const ordinaryTax = layerTax(0, ordTI, p.brackets);
  const tax1250 = layerTax(ordTI, ordTI + uPart, p.brackets, UNRECAPTURED_1250_MAX_RATE);
  const gLo = ordTI + uPart;
  const gHi = gLo + gPart;
  const taxCapitalGains =
    0.15 * overlap(gLo, gHi, p.ltcgZeroTop, p.ltcgFifteenTop) + 0.2 * overlap(gLo, gHi, p.ltcgFifteenTop, Infinity);

  const stacked = ordinaryTax + tax1250 + taxCapitalGains;
  const regularTax = layerTax(0, ti, p.brackets);
  const useRegular = regularTax < stacked;
  // Round each line, then sum the rounded lines, so the ledger always foots to the dollar.
  const incomeTax = useRegular
    ? Math.round(regularTax)
    : Math.round(ordinaryTax) + Math.round(tax1250) + Math.round(taxCapitalGains);

  const niit = Math.round(NIIT_RATE * Math.max(0, Math.min(Math.max(0, i.netInvestmentIncome), agi - p.niitThreshold)));

  return {
    agi: Math.round(agi),
    taxableIncome: Math.round(ti),
    ordinaryTaxable: Math.round(ordTI),
    ordinaryTax: Math.round(useRegular ? regularTax : ordinaryTax),
    tax1250: useRegular ? 0 : Math.round(tax1250),
    taxCapitalGains: useRegular ? 0 : Math.round(taxCapitalGains),
    regularTax: Math.round(regularTax),
    incomeTax,
    niit,
    total: incomeTax + niit,
    params: p,
  };
}

/**
 * IRC §469(i): up to $25,000 of rental losses for active participants, phased out by
 * 50% of modified AGI over $100,000 (gone at $150,000). Not inflation-indexed.
 */
export function passiveAllowance(magi: number): number {
  return Math.max(0, 25_000 - 0.5 * Math.max(0, magi - 100_000));
}

/** State tax as a flat marginal rate on AGI — a labelled simplification, see README. */
export function stateTax(agi: number, rate: number): number {
  return Math.round(rate * Math.max(0, agi));
}
