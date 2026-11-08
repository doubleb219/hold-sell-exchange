import { useState } from 'react';
import type { TransactionLedger } from '../engine/types';
import { money, ticks, usd } from './format';

interface Step {
  label: string;
  value: number; // signed change, or the total for kind = 'total'
  kind: 'total' | 'delta';
  note: string;
}

export function waterfallSteps(t: TransactionLedger): Step[] {
  const tax = t.taxImpact;
  const steps: Step[] = [
    { label: 'Sale price', value: t.price, kind: 'total', note: 'Market value in the transaction month' },
    { label: 'Selling costs', value: -(t.sellingCosts + t.exchangeCosts), kind: 'delta', note: 'Commission, transfer tax, escrow' + (t.exchangeCosts ? ', QI fee' : '') },
    { label: 'Loan payoff', value: -t.loanPayoff, kind: 'delta', note: 'All liens on the property' },
  ];
  const taxes: [string, number, string][] = [
    ['§1250 recapture', tax.recapture1250, 'Depreciation taken, taxed at ordinary rates up to 25%'],
    ['Capital gains', tax.capitalGains, 'Long-term gain at 0/15/20%, stacked above §1250 gain'],
    ['NIIT', tax.niit, '3.8% net investment income tax over $250k MAGI'],
    ['State', tax.state, 'State tax on the gain'],
    ['Released losses', tax.ordinary, 'Suspended passive losses + §1231 loss offsetting ordinary income'],
  ];
  for (const [label, v, note] of taxes) if (Math.round(v) !== 0) steps.push({ label, value: -v, kind: 'delta', note });
  const end = t.price - t.sellingCosts - t.exchangeCosts - t.loanPayoff - tax.total;
  steps.push({
    label: t.kind === 'sell' ? 'Cash to client' : 'Equity rolled over',
    value: end,
    kind: 'total',
    note: t.kind === 'sell' ? 'After every dollar of tax' : `Deferred gain of ${usd(t.deferredGain ?? 0)} travels with it`,
  });
  return steps;
}

const W = 760;
const H = 300;
const M = { t: 24, r: 12, b: 44, l: 56 };

export function Waterfall({ t, color }: { t: TransactionLedger; color: string }) {
  const steps = waterfallSteps(t);
  const [hover, setHover] = useState<number | null>(null);
  let run = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'total') {
      run = s.value;
      return { ...s, from: 0, to: s.value };
    }
    const from = run;
    run += s.value;
    return { ...s, from, to: run };
  });
  const hi = Math.max(...bars.map((b) => Math.max(b.from, b.to)));
  const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
  const yt = ticks(lo, hi, 5);
  const y0 = Math.min(lo, yt[0]);
  const y1 = Math.max(hi, yt.at(-1)!);
  const y = (v: number) => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);
  const bw = (W - M.l - M.r) / bars.length;
  const gap = Math.min(18, bw * 0.28);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Sale proceeds waterfall" style={{ display: 'block' }}>
        {yt.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} />
            <text x={M.l - 8} y={y(v) + 4} textAnchor="end">
              {money(v)}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const top = y(Math.max(b.from, b.to));
          const h = Math.max(1.5, Math.abs(y(b.from) - y(b.to)));
          const bx = M.l + i * bw + gap / 2;
          const fill = b.kind === 'total' ? color : b.value > 0 ? 'var(--exchange)' : 'var(--deduct)';
          return (
            <g key={b.label} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={M.l + i * bw} y={M.t} width={bw} height={H - M.t - M.b} fill="transparent" />
              <rect x={bx} y={top} width={bw - gap} height={h} rx={3} fill={fill} opacity={hover === null || hover === i ? 1 : 0.55} />
              {i < bars.length - 1 && (
                <line x1={bx + bw - gap} x2={bx + bw} y1={y(b.to)} y2={y(b.to)} stroke="var(--axis)" strokeDasharray="2 2" />
              )}
              <text x={bx + (bw - gap) / 2} y={top - 6} textAnchor="middle" className="ink2">
                {b.kind === 'total' ? money(b.value) : `${b.value < 0 ? '−' : '+'}${money(Math.abs(b.value))}`}
              </text>
              <text x={bx + (bw - gap) / 2} y={H - M.b + 16} textAnchor="middle">
                {b.label.split(' ')[0]}
              </text>
              <text x={bx + (bw - gap) / 2} y={H - M.b + 29} textAnchor="middle">
                {b.label.split(' ').slice(1).join(' ')}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: `${((M.l + (hover + 0.5) * bw) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}>
          <div className="h">{bars[hover].label}</div>
          <div className="r">
            <span>{bars[hover].kind === 'total' ? 'Total' : 'Change'}</span>
            <b>{usd(bars[hover].value)}</b>
          </div>
          <div className="sub">{bars[hover].note}</div>
        </div>
      )}
    </div>
  );
}
