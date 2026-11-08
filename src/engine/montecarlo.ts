import type { Assumptions, Household, Lens, SimResult, Strategy } from './types';
import { STRATEGIES } from './types';
import { generatePath, mulberry32 } from './market';
import { simulate } from './simulate';

export interface Band {
  p10: number[];
  p50: number[];
  p90: number[];
}

export interface MonteCarloResult {
  paths: number;
  seed: number;
  years: number[];
  bands: Record<Strategy, Record<Lens, Band>>;
  /** Share of paths in which each strategy finishes with the most wealth. */
  winRate: Record<Lens, Record<Strategy, number>>;
  terminal: Record<Strategy, Record<Lens, number[]>>;
}

export const pathIds = (h: Household) => [...h.properties.map((p) => p.id), 'replacement'];

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Deterministic base case: the expected path, every shock zero. */
export function runBaseCase(h: Household, a: Assumptions): Record<Strategy, SimResult> {
  const path = generatePath(a.market, pathIds(h), a.horizonYears * 12, null);
  return Object.fromEntries(STRATEGIES.map((s) => [s, simulate(h, a, s, path, { ledger: true })])) as Record<
    Strategy,
    SimResult
  >;
}

/**
 * Every strategy is run against the *same* market path (common random numbers),
 * so differences between strategies are the decision, not sampling noise.
 */
export function runMonteCarlo(h: Household, a: Assumptions, nPaths: number, seed: number): MonteCarloResult {
  const rng = mulberry32(seed);
  const months = a.horizonYears * 12;
  const ids = pathIds(h);
  const lenses: Lens[] = ['liquidation', 'heirs'];
  const series: Record<Strategy, Record<Lens, number[][]>> = {} as never;
  for (const s of STRATEGIES) series[s] = { liquidation: [], heirs: [] };
  const wins: Record<Lens, Record<Strategy, number>> = {
    liquidation: { hold: 0, sell: 0, exchange: 0 },
    heirs: { hold: 0, sell: 0, exchange: 0 },
  };
  let years: number[] = [];

  for (let i = 0; i < nPaths; i++) {
    const path = generatePath(a.market, ids, months, rng);
    const finals: Record<Lens, Partial<Record<Strategy, number>>> = { liquidation: {}, heirs: {} };
    for (const s of STRATEGIES) {
      const r = simulate(h, a, s, path);
      if (!years.length) years = r.points.map((p) => p.year);
      for (const l of lenses) {
        const v = r.points.map((p) => p[l]);
        series[s][l].push(v);
        finals[l][s] = v[v.length - 1];
      }
    }
    for (const l of lenses) {
      const best = STRATEGIES.reduce((b, s) => (finals[l][s]! > finals[l][b]! ? s : b), STRATEGIES[0]);
      wins[l][best] += 1;
    }
  }

  const bands = {} as Record<Strategy, Record<Lens, Band>>;
  const terminal = {} as Record<Strategy, Record<Lens, number[]>>;
  for (const s of STRATEGIES) {
    bands[s] = {} as Record<Lens, Band>;
    terminal[s] = {} as Record<Lens, number[]>;
    for (const l of lenses) {
      const rows = series[s][l];
      const band: Band = { p10: [], p50: [], p90: [] };
      for (let y = 0; y < years.length; y++) {
        const col = rows.map((r) => r[y]).sort((x, z) => x - z);
        band.p10.push(quantile(col, 0.1));
        band.p50.push(quantile(col, 0.5));
        band.p90.push(quantile(col, 0.9));
      }
      bands[s][l] = band;
      terminal[s][l] = rows.map((r) => r[r.length - 1]);
    }
  }
  for (const l of lenses) for (const s of STRATEGIES) wins[l][s] /= nPaths;

  return { paths: nPaths, seed, years, bands, winRate: wins, terminal };
}

export interface BreakevenGrid {
  decisionYears: number[];
  appreciation: number[];
  /** cells[i][j] = exchange − sell at the horizon, for appreciation[i] and decisionYears[j]. */
  cells: number[][];
}

/** Where does exchanging stop beating selling? Deterministic sweep over appreciation × timing. */
export function breakevenGrid(h: Household, a: Assumptions, lens: Lens): BreakevenGrid {
  const decisionYears = Array.from({ length: Math.min(10, a.horizonYears - 1) }, (_, i) => i + 1);
  const appreciation = [0.07, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01, 0, -0.01];
  const ids = pathIds(h);
  const cells = appreciation.map((hpa) => {
    const market = { ...a.market, hpa };
    const path = generatePath(market, ids, a.horizonYears * 12, null);
    return decisionYears.map((dy) => {
      const aa = { ...a, market, decisionYear: dy };
      const ex = simulate(h, aa, 'exchange', path).points.at(-1)![lens];
      const se = simulate(h, aa, 'sell', path).points.at(-1)![lens];
      return ex - se;
    });
  });
  return { decisionYears, appreciation, cells };
}
