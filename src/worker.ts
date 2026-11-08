/// <reference lib="webworker" />
import { breakevenGrid, runMonteCarlo, type BreakevenGrid, type MonteCarloResult } from './engine/montecarlo';
import type { Assumptions, Household } from './engine/types';

export interface WorkerRequest {
  id: number;
  household: Household;
  assumptions: Assumptions;
  paths: number;
  seed: number;
}
export interface WorkerResponse {
  id: number;
  mc: MonteCarloResult;
  grid: { liquidation: BreakevenGrid; heirs: BreakevenGrid };
  ms: number;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, household, assumptions, paths, seed } = e.data;
  const t0 = performance.now();
  const mc = runMonteCarlo(household, assumptions, paths, seed);
  const grid = {
    liquidation: breakevenGrid(household, assumptions, 'liquidation'),
    heirs: breakevenGrid(household, assumptions, 'heirs'),
  };
  const res: WorkerResponse = { id, mc, grid, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(res);
};
