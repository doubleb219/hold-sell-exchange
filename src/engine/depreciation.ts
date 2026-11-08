/**
 * Residential rental property: MACRS, 27.5-year straight line, mid-month convention
 * (IRS Pub. 946, Table A-6). The month placed in service and the month of disposition
 * each count as half a month.
 */

export const RESIDENTIAL_RECOVERY_MONTHS = 330; // 27.5 years

export interface Tranche {
  label: string;
  basis: number; // original depreciable basis of this tranche
  monthly: number; // allowance for a full month
  remaining: number; // undepreciated basis
  /** Simulation month index in which this tranche is placed in service (gets a half month). */
  startIndex: number | null;
}

/** Cumulative depreciation from placement through the end of (throughYear, throughMonth). */
export function scheduledDepreciation(
  basis: number,
  placedYear: number,
  placedMonth: number,
  throughYear: number,
  throughMonth: number,
): number {
  const fullMonthsAfter = (throughYear - placedYear) * 12 + (throughMonth - placedMonth);
  if (fullMonthsAfter < 0) return 0;
  const months = 0.5 + fullMonthsAfter;
  return Math.min(basis, (basis / RESIDENTIAL_RECOVERY_MONTHS) * months);
}

/** Depreciation allowed in one calendar year (matches the IRS percentage tables). */
export function annualDepreciation(basis: number, placedYear: number, placedMonth: number, year: number): number {
  return (
    scheduledDepreciation(basis, placedYear, placedMonth, year, 12) -
    scheduledDepreciation(basis, placedYear, placedMonth, year - 1, 12)
  );
}

export function newTranche(label: string, basis: number, startIndex: number | null): Tranche {
  return { label, basis, monthly: basis / RESIDENTIAL_RECOVERY_MONTHS, remaining: basis, startIndex };
}

/** Take one month of depreciation. `disposing` applies the half-month disposition convention. */
export function stepTranche(t: Tranche, monthIndex: number, disposing = false): number {
  if (t.remaining <= 0.005) {
    t.remaining = 0;
    return 0;
  }
  let factor = t.startIndex === monthIndex ? 0.5 : 1;
  if (disposing) factor = Math.min(factor, 0.5);
  const amount = Math.min(t.remaining, t.monthly * factor);
  t.remaining -= amount;
  return amount;
}
