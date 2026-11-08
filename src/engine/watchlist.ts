import type { Assumptions, Household } from './types';
import { initLoan, stepLoan } from './loans';
import { generatePath } from './market';
import { pathIds } from './montecarlo';

/**
 * Monitoring: the things that will change for this household before the client calls the advisor
 * about them. Computed on the expected path so every number is reproducible.
 */

export type Severity = 'act' | 'watch' | 'info';

export interface WatchItem {
  propertyId: string;
  propertyName: string;
  severity: Severity;
  title: string;
  detail: string;
  when?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export function watchlist(h: Household, a: Assumptions): WatchItem[] {
  const months = a.horizonYears * 12;
  const path = generatePath(a.market, pathIds(h), months, null);
  const items: WatchItem[] = [];
  const when = (m: number) => `${MONTHS[m % 12]} ${h.startYear + Math.floor(m / 12)}`;

  for (const p of h.properties) {
    const paidOff = p.loans.filter((l) => l.balance <= 0);
    if (paidOff.length)
      items.push({
        propertyId: p.id,
        propertyName: p.name,
        severity: 'info',
        title: `${paidOff.length} paid-off lien${paidOff.length > 1 ? 's' : ''} on record`,
        detail: `${paidOff.map((l) => l.label).join(', ')}. Carried at $0 and excluded from payoff; confirm each reconveyance is recorded before a sale.`,
      });

    for (const l of p.loans) {
      if (l.balance <= 0) continue;
      const s = initLoan(l);
      let prev = 0;
      let prevWasIO = false;
      for (let m = 0; m < months && s.balance > 0; m++) {
        const rateBefore = s.rate;
        const r = stepLoan(s, path.index[m]);
        const pay = r.interest + r.principal;
        const isIO = r.principal === 0;
        const changedTerms = (l.kind === 'arm' && s.rate !== rateBefore) || (prevWasIO && !isIO);
        prevWasIO = isIO;
        if (m > 0 && prev > 0 && changedTerms && Math.abs(pay - prev) / prev > 0.05) {
          const up = pay > prev;
          items.push({
            propertyId: p.id,
            propertyName: p.name,
            severity: m < 12 && up ? 'act' : 'watch',
            when: when(m),
            title:
              l.kind === 'arm'
                ? `ARM resets: ${pct(rateBefore)} → ${pct(s.rate)}`
                : l.kind === 'heloc'
                  ? 'HELOC draw period ends'
                  : 'Interest-only period ends',
            detail: `${l.label} payment ${up ? 'rises' : 'falls'} from ${usd(prev)} to ${usd(pay)}/mo (${up ? '+' : ''}${usd(
              (pay - prev) * 12,
            )}/yr) on the expected rate path.`,
          });
          break;
        }
        prev = pay;
      }
    }

    const cost = p.purchasePrice + p.improvements.reduce((x, i) => x + i.amount, 0);
    if (p.currentValue * (1 - p.sellingCostPct) < cost)
      items.push({
        propertyId: p.id,
        propertyName: p.name,
        severity: 'watch',
        title: 'Worth less than what was paid',
        detail: `Net of selling costs, a sale today realizes ${usd(p.currentValue * (1 - p.sellingCostPct))} against ${usd(
          cost,
        )} paid. Depending on depreciation taken, a taxable sale may produce an ordinary §1231 loss — and it releases suspended losses. An exchange would carry both forward instead.`,
      });

    if (p.suspendedLoss > 10_000 && h.wages > 150_000)
      items.push({
        propertyId: p.id,
        propertyName: p.name,
        severity: 'info',
        title: `${usd(p.suspendedLoss)} of suspended passive losses`,
        detail: `MAGI is over $150k, so the $25k rental allowance is gone. These losses are released only by a fully taxable sale of this property — an exchange carries them into the replacement.`,
      });
  }
  const rank: Record<Severity, number> = { act: 0, watch: 1, info: 2 };
  return items.sort((x, y) => rank[x.severity] - rank[y.severity]);
}
