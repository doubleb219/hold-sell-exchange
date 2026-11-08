// Core domain types. Every number the engine consumes is either a fact with a
// source, or an explicit, labelled assumption. Nothing is silently defaulted.

export type FilingStatus = 'mfj' | 'single';

export type SourceKind =
  | 'tax_return'
  | 'closing_statement'
  | 'lender_statement'
  | 'owner_asserted'
  | 'estimate'
  | 'derived';

export interface SourceTag {
  kind: SourceKind;
  document: string; // e.g. "2024 Form 4562, line 17"
  asOf: string; // ISO date the document speaks to
}

export type LoanKind = 'fixed' | 'interest_only' | 'arm' | 'heloc';

export interface Loan {
  id: string;
  label: string;
  kind: LoanKind;
  balance: number;
  rate: number; // current note rate, annual decimal
  amortMonthsRemaining: number; // months left on the amortization schedule (after any IO / draw period)
  ioMonthsRemaining?: number; // interest_only only
  arm?: {
    monthsToReset: number; // months until the next rate change (0 = changes this month)
    resetEveryMonths: number;
    margin: number; // added to the index
    periodicCap: number; // max change per reset
    lifetimeCap: number; // absolute ceiling on the note rate
    floor: number; // absolute floor on the note rate
  };
  heloc?: {
    drawMonthsRemaining: number; // interest-only draw period
    margin: number; // over the index, variable monthly
    repayMonths: number; // amortization period after the draw ends
  };
  source: SourceTag;
}

export interface Improvement {
  label: string;
  year: number;
  month: number;
  amount: number;
}

export interface Property {
  id: string;
  name: string;
  location: string;
  kind: string;
  placedInService: { year: number; month: number };
  purchasePrice: number;
  landPct: number; // share of purchase price allocated to non-depreciable land
  improvements: Improvement[];
  currentValue: number;
  monthlyRent: number;
  vacancy: number;
  opexPct: number; // maintenance, management, HOA, as % of collected rent
  annualPropertyTax: number;
  propertyTaxGrowth: number; // e.g. 2% under CA Prop 13
  annualInsurance: number;
  appreciationPremium: number; // annual, vs. the national path
  sellingCostPct: number;
  /** Accumulated depreciation as reported. If absent, derived from the MACRS schedule. */
  accumulatedDepreciation?: number;
  /** Suspended passive losses carried forward under IRC §469. */
  suspendedLoss: number;
  loans: Loan[];
  sources: Partial<Record<string, SourceTag>>;
}

export type ObservableField =
  | 'accumulatedDepreciation'
  | 'currentValue'
  | 'suspendedLoss'
  | `loanBalance:${string}`;

/** One document's claim about one fact. Several observations of the same fact must be reconciled. */
export interface Observation {
  id: string;
  propertyId: string;
  field: ObservableField;
  value: number;
  source: SourceTag;
  note?: string;
}

export interface Household {
  name: string;
  filing: FilingStatus;
  state: string;
  stateRate: number; // flat marginal state rate (see README: deliberate scope cut)
  wages: number;
  wageGrowth: number;
  startYear: number; // simulation starts January of this year
  liquid: number; // taxable brokerage account
  liquidBasis: number;
  properties: Property[];
  observations: Observation[];
}

export interface MarketAssumptions {
  hpa: number; // expected annual home-price appreciation
  hpaVol: number;
  hpaMomentum: number; // monthly AR(1) coefficient on appreciation shocks
  idioVol: number; // property-specific annual vol
  rentGrowth: number;
  rentVol: number;
  rate0: number; // starting short-rate index (SOFR-like)
  rateMean: number;
  rateSpeed: number;
  rateVol: number;
  equityReturn: number;
  equityVol: number;
  dividendYield: number;
  inflation: number; // indexes tax brackets, insurance
}

export interface ReplacementAssumptions {
  ltv: number;
  rate: number;
  amortMonths: number;
  grossYield: number; // annual gross rent / price
  vacancy: number;
  opexPct: number;
  propertyTaxRate: number;
  insuranceRate: number;
  landPct: number;
  appreciationPremium: number;
  sellingCostPct: number;
}

export interface Assumptions {
  horizonYears: number;
  decisionYear: number; // transaction happens in January of startYear + decisionYear
  subjectId: string;
  market: MarketAssumptions;
  replacement: ReplacementAssumptions;
  exchangeCosts: number; // qualified intermediary + extra closing costs
}

export type Strategy = 'hold' | 'sell' | 'exchange';
export const STRATEGIES: Strategy[] = ['hold', 'sell', 'exchange'];
export type Lens = 'liquidation' | 'heirs';

export interface YearPoint {
  year: number;
  realEstateValue: number;
  debt: number;
  liquid: number;
  /** Equity + liquid, assuming §1014 step-up at death (no income tax on embedded gains). */
  heirs: number;
  /** Everything sold on Dec 31: after selling costs, debt payoff, and every dollar of tax. */
  liquidation: number;
  taxPaid: number;
}

export interface YearLedger {
  year: number;
  effectiveRent: number;
  operatingExpenses: number;
  interest: number;
  principal: number;
  depreciation: number;
  netPassive: number;
  passiveAllowed: number;
  suspendedAdded: number;
  suspendedUsed: number;
  suspendedReleased: number;
  suspendedEnding: number;
  ordinaryIncome: number;
  unrecaptured1250: number;
  capitalGain: number;
  federal: number;
  niit: number;
  state: number;
  totalTax: number;
  /** Tax above a wages-only return — what the real estate and portfolio actually cost. */
  attributableTax: number;
  preTaxCashFlow: number;
}

export interface TaxImpact {
  ordinary: number;
  recapture1250: number;
  capitalGains: number;
  niit: number;
  state: number;
  total: number;
}

export interface TransactionLedger {
  kind: 'sell' | 'exchange';
  year: number;
  month: number;
  propertyName: string;
  price: number;
  sellingCosts: number;
  exchangeCosts: number;
  amountRealized: number;
  costBasis: number;
  depreciationTaken: number;
  adjustedBasis: number;
  realizedGain: number;
  unrecaptured1250: number;
  capitalGain: number;
  ordinaryLoss: number;
  loanPayoff: number;
  suspendedReleased: number;
  suspendedCarried: number;
  // exchange-only
  replacementPrice?: number;
  replacementDebt?: number;
  boot?: number;
  recognizedGain?: number;
  deferredGain?: number;
  replacementBasis?: number;
  carryoverDepreciableBasis?: number;
  excessDepreciableBasis?: number;
  /** Incremental tax caused by this transaction's items (filled at year end). */
  taxImpact: TaxImpact;
  netCash: number;
}

export interface SimResult {
  strategy: Strategy;
  points: YearPoint[];
  ledgers: YearLedger[];
  transaction?: TransactionLedger;
}
