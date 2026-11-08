import type {
  Assumptions,
  Household,
  Property,
  SimResult,
  Strategy,
  TaxImpact,
  TransactionLedger,
  YearLedger,
  YearPoint,
} from './types';
import { federalTax, passiveAllowance, stateTax, type FederalResult } from './tax';
import { initLoan, stepLoan, type LoanState } from './loans';
import { newTranche, scheduledDepreciation, stepTranche, type Tranche } from './depreciation';
import type { MarketPath } from './market';

/* ------------------------------------------------------------------ state */

interface YearAcc {
  effectiveRent: number;
  opex: number;
  interest: number;
  principal: number;
  depreciation: number;
}
const emptyAcc = (): YearAcc => ({ effectiveRent: 0, opex: 0, interest: 0, principal: 0, depreciation: 0 });
const net = (a: YearAcc) => a.effectiveRent - a.opex - a.interest - a.depreciation;

export interface PropertyState {
  id: string;
  name: string;
  pathId: string;
  active: boolean;
  /** Sold in a fully taxable transaction this year: its losses are non-passive (§469(g)). */
  taxableDisposalYear: number | null;
  value: number;
  monthlyRent: number;
  vacancy: number;
  opexPct: number;
  propertyTax: number;
  propertyTaxGrowth: number;
  insurance: number;
  premium: number;
  sellingCostPct: number;
  landPct: number;
  loans: LoanState[];
  tranches: Tranche[];
  costBasis: number;
  /** Adjusted basis: cost − depreciation (for exchange property: price − deferred gain − depreciation since). */
  basis: number;
  /** Depreciation that will be taxed as unrecaptured §1250 gain on a taxable sale (carries through 1031s). */
  depTaken: number;
  suspended: number;
  acc: YearAcc;
}

export function initPropertyState(p: Property, startYear: number): PropertyState {
  const tranches: Tranche[] = [];
  const mk = (label: string, basis: number, y: number, m: number) => {
    const t = newTranche(label, basis, null);
    t.remaining = Math.max(0, basis - scheduledDepreciation(basis, y, m, startYear - 1, 12));
    tranches.push(t);
  };
  mk('Building', p.purchasePrice * (1 - p.landPct), p.placedInService.year, p.placedInService.month);
  for (const imp of p.improvements) mk(imp.label, imp.amount, imp.year, imp.month);

  const scheduled = tranches.reduce((s, t) => s + (t.basis - t.remaining), 0);
  let depTaken = scheduled;
  if (p.accumulatedDepreciation !== undefined) {
    // The return is what was actually claimed ("allowed or allowable"). Absorb any difference
    // in the building tranche so future allowances never exceed remaining basis.
    const delta = p.accumulatedDepreciation - scheduled;
    const b = tranches[0];
    b.remaining = Math.min(b.basis, Math.max(0, b.remaining - delta));
    depTaken = p.accumulatedDepreciation;
  }
  const costBasis = p.purchasePrice + p.improvements.reduce((s, i) => s + i.amount, 0);

  return {
    id: p.id,
    name: p.name,
    pathId: p.id,
    active: true,
    taxableDisposalYear: null,
    value: p.currentValue,
    monthlyRent: p.monthlyRent,
    vacancy: p.vacancy,
    opexPct: p.opexPct,
    propertyTax: p.annualPropertyTax,
    propertyTaxGrowth: p.propertyTaxGrowth,
    insurance: p.annualInsurance,
    premium: p.appreciationPremium,
    sellingCostPct: p.sellingCostPct,
    landPct: p.landPct,
    loans: p.loans.map(initLoan),
    tranches,
    costBasis,
    basis: costBasis - depTaken,
    depTaken,
    suspended: p.suspendedLoss,
    acc: emptyAcc(),
  };
}

const debtOf = (p: PropertyState) => p.loans.reduce((s, l) => s + l.balance, 0);

/* -------------------------------------------------------------- year tax */

interface TaxInputs {
  year: number;
  wages: number;
  passiveNet: number; // net of all properties whose activity is still passive this year
  pool: number; // suspended losses available to absorb passive income
  canSuspend: boolean;
  nonPassive: number; // disposed-property income/loss and released suspended losses
  unrecaptured1250: number;
  capitalGain: number; // property LTCG + realized portfolio gains
  qualifiedDividends: number;
  ordinaryLoss: number; // §1231 losses
}

interface TaxOutcome {
  fed: FederalResult;
  state: number;
  total: number;
  passiveIncome: number;
  allowed: number;
  used: number;
  added: number;
  ordinaryIncome: number;
}

const EMPTY_INPUTS: TaxInputs = {
  year: 0,
  wages: 0,
  passiveNet: 0,
  pool: 0,
  canSuspend: true,
  nonPassive: 0,
  unrecaptured1250: 0,
  capitalGain: 0,
  qualifiedDividends: 0,
  ordinaryLoss: 0,
};

function computeTax(t: TaxInputs, h: Household, inflation: number): TaxOutcome {
  let passiveIncome: number;
  let used = 0;
  let allowed = 0;
  let added = 0;
  if (t.passiveNet >= 0) {
    used = Math.min(t.passiveNet, t.pool);
    passiveIncome = t.passiveNet - used;
  } else if (!t.canSuspend) {
    passiveIncome = t.passiveNet;
    allowed = -t.passiveNet;
  } else {
    const magi = t.wages + t.qualifiedDividends + Math.max(0, t.nonPassive);
    allowed = Math.min(-t.passiveNet, passiveAllowance(magi));
    passiveIncome = -allowed;
    added = -t.passiveNet - allowed;
  }
  const ordinaryIncome = t.wages + passiveIncome + t.nonPassive + t.ordinaryLoss;
  const capitalGain = t.capitalGain + t.qualifiedDividends;
  const nii = passiveIncome + t.nonPassive + t.ordinaryLoss + t.unrecaptured1250 + capitalGain;
  const fed = federalTax({
    ordinaryIncome,
    unrecaptured1250: t.unrecaptured1250,
    capitalGain,
    netInvestmentIncome: nii,
    filing: h.filing,
    year: t.year,
    inflation,
  });
  const state = stateTax(fed.agi, h.stateRate);
  return { fed, state, total: fed.total + state, passiveIncome, allowed, used, added, ordinaryIncome };
}

function impact(withT: TaxOutcome, withoutT: TaxOutcome): TaxImpact {
  return {
    ordinary: withT.fed.ordinaryTax - withoutT.fed.ordinaryTax,
    recapture1250: withT.fed.tax1250 - withoutT.fed.tax1250,
    capitalGains: withT.fed.taxCapitalGains - withoutT.fed.taxCapitalGains,
    niit: withT.fed.niit - withoutT.fed.niit,
    state: withT.state - withoutT.state,
    total: withT.total - withoutT.total,
  };
}

/* ------------------------------------------------------------ simulation */

interface SaleItems {
  unrecaptured1250: number;
  capitalGain: number;
  ordinaryLoss: number;
  released: number;
}

function saleCharacter(gain: number, depTaken: number): Omit<SaleItems, 'released'> {
  if (gain < 0) return { unrecaptured1250: 0, capitalGain: 0, ordinaryLoss: gain }; // §1231 loss → ordinary
  const u = Math.min(gain, depTaken);
  return { unrecaptured1250: u, capitalGain: gain - u, ordinaryLoss: 0 };
}

export interface SimulateOptions {
  ledger?: boolean;
}

export function simulate(
  h: Household,
  a: Assumptions,
  strategy: Strategy,
  path: MarketPath,
  opts: SimulateOptions = {},
): SimResult {
  const months = a.horizonYears * 12;
  if (path.months < months) throw new Error('Market path shorter than horizon');
  const decisionMonth = a.decisionYear * 12;
  const props = h.properties.map((p) => initPropertyState(p, h.startYear));
  if (!props.some((p) => p.id === a.subjectId)) throw new Error(`Unknown subject property ${a.subjectId}`);

  let liquid = h.liquid;
  let liquidBasis = h.liquidBasis;
  const points: YearPoint[] = [];
  const ledgers: YearLedger[] = [];
  let transaction: TransactionLedger | undefined;
  let eventItems: (SaleItems & { disposedNet: () => number; kind: Strategy }) | null = null;

  // Year accumulators
  let ySale: SaleItems = { unrecaptured1250: 0, capitalGain: 0, ordinaryLoss: 0, released: 0 };
  let yDividends = 0;
  let yPortfolioGain = 0;
  let yCashFlow = 0;

  const deposit = (x: number) => {
    if (x >= 0) {
      if (liquid < 0) {
        const pay = Math.min(x, -liquid);
        liquid += pay;
        x -= pay;
      }
      liquid += x;
      liquidBasis += x;
    } else {
      const amount = -x;
      if (liquid > 0) {
        const portion = Math.min(amount, liquid);
        const frac = portion / liquid;
        yPortfolioGain += frac * (liquid - liquidBasis);
        liquidBasis -= frac * liquidBasis;
      }
      liquid -= amount;
      if (liquid <= 0) liquidBasis = 0;
    }
  };

  const snapshot = (year: number, actual: TaxInputs | null, taxPaid: number): YearPoint => {
    const active = props.filter((p) => p.active);
    const realEstateValue = active.reduce((s, p) => s + p.value, 0);
    const debt = active.reduce((s, p) => s + debtOf(p), 0);
    const heirs = realEstateValue - debt + liquid;

    // Hypothetical: liquidate everything on Dec 31 of this year.
    let hypU = 0;
    let hypG = 0;
    let hypOrd = 0;
    let netProceeds = 0;
    let released = 0;
    for (const p of active) {
      const ar = p.value * (1 - p.sellingCostPct);
      const c = saleCharacter(ar - p.basis, p.depTaken);
      hypU += c.unrecaptured1250;
      hypG += c.capitalGain;
      hypOrd += c.ordinaryLoss;
      released += p.suspended;
      netProceeds += ar - debtOf(p);
    }
    const portGain = liquid > 0 ? liquid - liquidBasis : 0;
    const base: TaxInputs = actual ?? { ...EMPTY_INPUTS, year, wages: h.wages };
    const without = computeTax(base, h, a.market.inflation);
    const withLiq = computeTax(
      {
        ...base,
        nonPassive: base.nonPassive - released,
        unrecaptured1250: base.unrecaptured1250 + hypU,
        capitalGain: base.capitalGain + hypG + portGain,
        ordinaryLoss: base.ordinaryLoss + hypOrd,
      },
      h,
      a.market.inflation,
    );
    const liquidation = netProceeds + liquid - (withLiq.total - without.total);
    return { year, realEstateValue, debt, liquid, heirs, liquidation, taxPaid };
  };

  points.push(snapshot(h.startYear - 1, null, 0));

  for (let m = 0; m < months; m++) {
    const year = h.startYear + Math.floor(m / 12);
    const month = (m % 12) + 1;
    const t = Math.floor(m / 12);

    /* ---- transaction ---- */
    if (m === decisionMonth && strategy !== 'hold') {
      const sp = props.find((p) => p.id === a.subjectId && p.active);
      if (sp) {
        for (const tr of sp.tranches) {
          const d = stepTranche(tr, m, true);
          sp.acc.depreciation += d;
          sp.basis -= d;
          sp.depTaken += d;
        }
        const price = sp.value;
        const sellingCosts = price * sp.sellingCostPct;
        const exchangeCosts = strategy === 'exchange' ? a.exchangeCosts : 0;
        const amountRealized = price - sellingCosts - exchangeCosts;
        const loanPayoff = debtOf(sp);
        for (const l of sp.loans) l.balance = 0;
        const realizedGain = amountRealized - sp.basis;
        const adjustedBasis = sp.basis;
        const depTakenAtSale = sp.depTaken;
        sp.active = false;

        if (strategy === 'sell') {
          const c = saleCharacter(realizedGain, sp.depTaken);
          const released = sp.suspended;
          sp.suspended = 0;
          sp.taxableDisposalYear = year;
          ySale = {
            unrecaptured1250: ySale.unrecaptured1250 + c.unrecaptured1250,
            capitalGain: ySale.capitalGain + c.capitalGain,
            ordinaryLoss: ySale.ordinaryLoss + c.ordinaryLoss,
            released: ySale.released + released,
          };
          const acc = sp.acc;
          eventItems = { ...c, released, disposedNet: () => net(acc), kind: 'sell' };
          deposit(amountRealized - loanPayoff);
          transaction = {
            kind: 'sell',
            year,
            month,
            propertyName: sp.name,
            price,
            sellingCosts,
            exchangeCosts,
            amountRealized,
            costBasis: sp.costBasis,
            depreciationTaken: depTakenAtSale,
            adjustedBasis,
            realizedGain,
            ...c,
            loanPayoff,
            suspendedReleased: released,
            suspendedCarried: 0,
            taxImpact: { ordinary: 0, recapture1250: 0, capitalGains: 0, niit: 0, state: 0, total: 0 },
            netCash: amountRealized - loanPayoff,
          };
        } else {
          // IRC §1031. All equity is reinvested; the replacement is levered to the target LTV.
          const r = a.replacement;
          const equity = amountRealized - loanPayoff;
          const replacementPrice = equity / (1 - r.ltv);
          const replacementDebt = replacementPrice - equity;
          // Net debt relief not offset by new debt is mortgage boot (Reg. §1.1031(d)-2).
          const boot = Math.max(0, loanPayoff - replacementDebt);
          const recognizedGain = Math.min(Math.max(0, realizedGain), boot);
          const c = saleCharacter(recognizedGain, sp.depTaken);
          const deferredGain = realizedGain - recognizedGain;
          const replacementBasis = replacementPrice - deferredGain;

          // Reg. §1.168(i)-6: exchanged basis keeps depreciating on the relinquished schedule;
          // excess basis is a new 27.5-year asset placed in service at the exchange.
          const depreciable = Math.max(0, replacementBasis * (1 - r.landPct));
          const carryAvail = sp.tranches.reduce((s, x) => s + x.remaining, 0);
          const carry = Math.min(depreciable, carryAvail);
          const scale = carryAvail > 0 ? carry / carryAvail : 0;
          const tranches: Tranche[] = sp.tranches
            .filter((x) => x.remaining > 0.005)
            .map((x) => ({
              label: `${x.label} (exchanged basis)`,
              basis: x.basis * scale,
              monthly: x.monthly * scale,
              remaining: x.remaining * scale,
              startIndex: m,
            }));
          const excess = depreciable - carry;
          if (excess > 0.005) tranches.push(newTranche('Excess basis', excess, m));

          ySale = {
            ...ySale,
            unrecaptured1250: ySale.unrecaptured1250 + c.unrecaptured1250,
            capitalGain: ySale.capitalGain + c.capitalGain,
          };
          eventItems = { ...c, released: 0, disposedNet: () => 0, kind: 'exchange' };

          const replacement: PropertyState = {
            id: 'replacement',
            name: `Replacement for ${sp.name}`,
            pathId: 'replacement',
            active: true,
            taxableDisposalYear: null,
            value: replacementPrice,
            monthlyRent: (replacementPrice * r.grossYield) / 12,
            vacancy: r.vacancy,
            opexPct: r.opexPct,
            propertyTax: replacementPrice * r.propertyTaxRate,
            propertyTaxGrowth: 0.02,
            insurance: replacementPrice * r.insuranceRate,
            premium: r.appreciationPremium,
            sellingCostPct: r.sellingCostPct,
            landPct: r.landPct,
            loans: [
              initLoan({
                id: 'replacement-loan',
                label: 'Replacement mortgage',
                kind: 'fixed',
                balance: replacementDebt,
                rate: r.rate,
                amortMonthsRemaining: r.amortMonths,
                source: { kind: 'estimate', document: 'Assumed new financing', asOf: `${year}-01-01` },
              }),
            ],
            tranches,
            costBasis: replacementPrice,
            basis: replacementBasis,
            depTaken: sp.depTaken - c.unrecaptured1250,
            suspended: sp.suspended, // §469: an exchange is not a taxable disposition — losses stay suspended
            acc: emptyAcc(),
          };
          const carried = sp.suspended;
          sp.suspended = 0;
          props.push(replacement);
          transaction = {
            kind: 'exchange',
            year,
            month,
            propertyName: sp.name,
            price,
            sellingCosts,
            exchangeCosts,
            amountRealized,
            costBasis: sp.costBasis,
            depreciationTaken: depTakenAtSale,
            adjustedBasis,
            realizedGain,
            ...c,
            loanPayoff,
            suspendedReleased: 0,
            suspendedCarried: carried,
            replacementPrice,
            replacementDebt,
            boot,
            recognizedGain,
            deferredGain,
            replacementBasis,
            carryoverDepreciableBasis: carry,
            excessDepreciableBasis: Math.max(0, excess),
            taxImpact: { ordinary: 0, recapture1250: 0, capitalGains: 0, niit: 0, state: 0, total: 0 },
            netCash: 0,
          };
        }
      }
    }

    /* ---- operations ---- */
    for (const p of props) {
      if (!p.active) continue;
      if (month === 1 && m > 0) {
        p.propertyTax *= 1 + p.propertyTaxGrowth;
        p.insurance *= 1 + a.market.inflation;
      }
      p.value *= Math.exp(path.hpa[m] + p.premium / 12 + (path.idio[p.pathId]?.[m] ?? 0));
      p.monthlyRent *= Math.exp(path.rent[m]);
      const eff = p.monthlyRent * (1 - p.vacancy);
      const opex = eff * p.opexPct + p.propertyTax / 12 + p.insurance / 12;
      let interest = 0;
      let principal = 0;
      for (const l of p.loans) {
        const r = stepLoan(l, path.index[m]);
        interest += r.interest;
        principal += r.principal;
      }
      let dep = 0;
      for (const tr of p.tranches) dep += stepTranche(tr, m);
      p.basis -= dep;
      p.depTaken += dep;
      p.acc.effectiveRent += eff;
      p.acc.opex += opex;
      p.acc.interest += interest;
      p.acc.principal += principal;
      p.acc.depreciation += dep;
      const cash = eff - opex - interest - principal;
      yCashFlow += cash;
      deposit(cash);
    }

    /* ---- portfolio ---- */
    if (liquid > 0) {
      const div = (liquid * a.market.dividendYield) / 12;
      yDividends += div;
      liquidBasis += div; // reinvested dividends add basis
      liquid *= Math.exp(path.equity[m]);
    } else {
      liquid *= 1 + (path.index[m] + 0.02) / 12; // negative balance = borrowing
    }

    /* ---- year end ---- */
    if (month === 12) {
      const wages = h.wages * Math.pow(1 + h.wageGrowth, t);
      let passiveNet = 0;
      let nonPassive = -ySale.released;
      for (const p of props) {
        if (p.taxableDisposalYear === year) nonPassive += net(p.acc);
        else passiveNet += net(p.acc);
      }
      const active = props.filter((p) => p.active);
      const pool = active.reduce((s, p) => s + p.suspended, 0);
      const inputs: TaxInputs = {
        year,
        wages,
        passiveNet,
        pool,
        canSuspend: active.length > 0,
        nonPassive,
        unrecaptured1250: ySale.unrecaptured1250,
        capitalGain: ySale.capitalGain + yPortfolioGain,
        qualifiedDividends: yDividends,
        ordinaryLoss: ySale.ordinaryLoss,
      };
      const out = computeTax(inputs, h, a.market.inflation);

      // Apply the §469 plan to per-property suspended balances.
      if (out.used > 0 && pool > 0) for (const p of active) p.suspended -= (out.used * p.suspended) / pool;
      if (out.added > 0) {
        const losers = active.filter((p) => net(p.acc) < 0);
        const weights = losers.length ? losers.map((p) => -net(p.acc)) : active.map((p) => p.value);
        const targets = losers.length ? losers : active;
        const wsum = weights.reduce((s, w) => s + w, 0);
        targets.forEach((p, i) => (p.suspended += (out.added * weights[i]) / wsum));
      }

      if (transaction && eventItems && transaction.year === year) {
        const dn = eventItems.disposedNet();
        const without = computeTax(
          {
            ...inputs,
            passiveNet: passiveNet + dn,
            nonPassive: nonPassive - dn + eventItems.released,
            pool: pool + eventItems.released,
            unrecaptured1250: inputs.unrecaptured1250 - eventItems.unrecaptured1250,
            capitalGain: inputs.capitalGain - eventItems.capitalGain,
            ordinaryLoss: inputs.ordinaryLoss - eventItems.ordinaryLoss,
          },
          h,
          a.market.inflation,
        );
        transaction.taxImpact = impact(out, without);
        if (transaction.kind === 'sell') transaction.netCash -= transaction.taxImpact.total;
        eventItems = null;
      }

      // Wages are consumed outside the model; the portfolio pays only the tax that real
      // estate and investments add on top of a wages-only return.
      const wagesOnly = computeTax({ ...EMPTY_INPUTS, year, wages }, h, a.market.inflation);
      const attributable = out.total - wagesOnly.total;
      deposit(-attributable);

      if (opts.ledger) {
        const sum = (f: (x: YearAcc) => number) => props.reduce((s, p) => s + f(p.acc), 0);
        ledgers.push({
          year,
          effectiveRent: sum((x) => x.effectiveRent),
          operatingExpenses: sum((x) => x.opex),
          interest: sum((x) => x.interest),
          principal: sum((x) => x.principal),
          depreciation: sum((x) => x.depreciation),
          netPassive: passiveNet,
          passiveAllowed: out.allowed,
          suspendedAdded: out.added,
          suspendedUsed: out.used,
          suspendedReleased: ySale.released,
          suspendedEnding: props.reduce((s, p) => s + (p.active ? p.suspended : 0), 0),
          ordinaryIncome: out.ordinaryIncome,
          unrecaptured1250: inputs.unrecaptured1250,
          capitalGain: inputs.capitalGain + inputs.qualifiedDividends,
          federal: out.fed.incomeTax,
          niit: out.fed.niit,
          state: out.state,
          totalTax: out.total,
          attributableTax: attributable,
          preTaxCashFlow: yCashFlow,
        });
      }

      points.push(snapshot(year, inputs, attributable));

      for (const p of props) p.acc = emptyAcc();
      ySale = { unrecaptured1250: 0, capitalGain: 0, ordinaryLoss: 0, released: 0 };
      yDividends = 0;
      yPortfolioGain = 0;
      yCashFlow = 0;
    }
  }

  return { strategy, points, ledgers, transaction };
}
