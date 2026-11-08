import type { Loan } from './types';

/**
 * Month-by-month loan mechanics for the instruments advisors actually see:
 * fixed, interest-only (with conversion to amortizing), ARMs with periodic and
 * lifetime caps, HELOCs with a variable rate and draw/repay phases, and zero-balance
 * (paid-off) liens that must be carried on the books but never generate a payment.
 */

export interface LoanState {
  def: Loan;
  balance: number;
  rate: number;
  amortLeft: number;
  ioLeft: number;
  resetIn: number;
  drawLeft: number;
}

export function initLoan(def: Loan): LoanState {
  const drawLeft = def.heloc?.drawMonthsRemaining ?? 0;
  return {
    def,
    balance: def.balance,
    rate: def.rate,
    amortLeft: def.kind === 'heloc' && drawLeft > 0 ? def.heloc!.repayMonths : def.amortMonthsRemaining,
    ioLeft: def.kind === 'interest_only' ? def.ioMonthsRemaining ?? 0 : 0,
    resetIn: def.arm?.monthsToReset ?? 0,
    drawLeft,
  };
}

export function annuityPayment(principal: number, annualRate: number, months: number): number {
  if (months <= 0) return principal;
  const i = annualRate / 12;
  if (i === 0) return principal / months;
  return (principal * i) / (1 - Math.pow(1 + i, -months));
}

/** ARM resets round the fully indexed rate to the nearest 1/8 of a percent (standard note language). */
export function roundToEighth(rate: number): number {
  return Math.round(rate * 800) / 800;
}

export interface LoanMonth {
  interest: number;
  principal: number;
}

export function stepLoan(s: LoanState, indexRate: number): LoanMonth {
  if (s.balance < 0.005) {
    s.balance = 0;
    return { interest: 0, principal: 0 };
  }
  const d = s.def;

  if (d.kind === 'arm' && d.arm) {
    if (s.resetIn <= 0) {
      const target = roundToEighth(indexRate + d.arm.margin);
      const lo = Math.max(d.arm.floor, s.rate - d.arm.periodicCap);
      const hi = Math.min(d.arm.lifetimeCap, s.rate + d.arm.periodicCap);
      s.rate = Math.min(hi, Math.max(lo, target));
      s.resetIn = d.arm.resetEveryMonths;
    }
    s.resetIn -= 1;
  }
  if (d.kind === 'heloc' && d.heloc) s.rate = Math.max(0, indexRate + d.heloc.margin);

  const interest = (s.balance * s.rate) / 12;
  let principal = 0;

  const interestOnly = (d.kind === 'interest_only' && s.ioLeft > 0) || (d.kind === 'heloc' && s.drawLeft > 0);
  if (interestOnly) {
    if (d.kind === 'interest_only') s.ioLeft -= 1;
    else s.drawLeft -= 1;
  } else {
    const n = Math.max(1, s.amortLeft);
    const payment = annuityPayment(s.balance, s.rate, n);
    principal = Math.min(s.balance, payment - interest);
    s.amortLeft = n - 1;
  }
  s.balance -= principal;
  return { interest, principal };
}

export function describeLoan(l: Loan): string {
  const pct = (r: number) => `${(r * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
  if (l.balance <= 0) return 'Paid off — $0 balance, kept on record';
  switch (l.kind) {
    case 'fixed':
      return `Fixed ${pct(l.rate)}, ${l.amortMonthsRemaining} mo left`;
    case 'interest_only':
      return `Interest-only ${pct(l.rate)} for ${l.ioMonthsRemaining} mo, then ${l.amortMonthsRemaining} mo amortizing`;
    case 'arm':
      return `ARM ${pct(l.rate)}, resets in ${l.arm!.monthsToReset} mo to index + ${pct(l.arm!.margin)} (cap ±${pct(l.arm!.periodicCap)}, max ${pct(l.arm!.lifetimeCap)})`;
    case 'heloc':
      return `HELOC index + ${pct(l.heloc!.margin)}, draw period ${l.heloc!.drawMonthsRemaining} mo then ${l.heloc!.repayMonths} mo repay`;
  }
}
