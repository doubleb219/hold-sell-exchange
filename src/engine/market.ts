import type { MarketAssumptions } from './types';

/** Seeded PRNG (mulberry32): the same seed always produces the same paths. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Monthly log changes for one simulated future. */
export interface MarketPath {
  months: number;
  hpa: Float64Array; // national monthly log appreciation
  idio: Record<string, Float64Array>; // property-specific monthly log shocks
  rent: Float64Array; // monthly log rent growth
  index: Float64Array; // short-rate index level (annual decimal)
  equity: Float64Array; // monthly log total return of the taxable portfolio
}

/**
 * Monthly AR(1) shock with persistence phi, scaled so the 12-month sum has the target annual vol.
 * House prices trend — momentum is a defining feature of the asset — so iid shocks would understate
 * the risk of a multi-year drawdown like 2007–2011.
 */
function ar1Sigma(annualVol: number, phi: number): number {
  const n = 12;
  let factor = n;
  for (let k = 1; k < n; k++) factor += 2 * (n - k) * Math.pow(phi, k);
  return annualVol * Math.sqrt((1 - phi * phi) / factor);
}

/** Pass `rng = null` for the deterministic expected path (every shock = 0). */
export function generatePath(
  a: MarketAssumptions,
  propertyIds: string[],
  months: number,
  rng: (() => number) | null,
): MarketPath {
  const z = () => (rng ? gaussian(rng) : 0);
  const hpa = new Float64Array(months);
  const rent = new Float64Array(months);
  const index = new Float64Array(months);
  const equity = new Float64Array(months);
  const idio: Record<string, Float64Array> = {};
  for (const id of propertyIds) idio[id] = new Float64Array(months);

  const hpaMu = Math.log(1 + a.hpa) / 12;
  const sigma = ar1Sigma(a.hpaVol, a.hpaMomentum);
  const rentMu = Math.log(1 + a.rentGrowth) / 12;
  const rentSigma = a.rentVol / Math.sqrt(12);
  const idioSigma = a.idioVol / Math.sqrt(12);
  const eqMu = Math.log(1 + a.equityReturn) / 12;
  const eqSigma = a.equityVol / Math.sqrt(12);
  const dt = 1 / 12;

  let dev = 0;
  let r = a.rate0;
  for (let m = 0; m < months; m++) {
    dev = a.hpaMomentum * dev + sigma * z();
    hpa[m] = hpaMu + dev;
    rent[m] = rentMu + 0.25 * dev + rentSigma * z();
    for (const id of propertyIds) idio[id][m] = idioSigma * z();
    // Vasicek short rate, floored at zero.
    r = Math.max(0, r + a.rateSpeed * (a.rateMean - r) * dt + a.rateVol * Math.sqrt(dt) * z());
    index[m] = r;
    // Log mean is set so the *median* path compounds at equityReturn.
    equity[m] = eqMu + eqSigma * z();
  }
  return { months, hpa, idio, rent, index, equity };
}
