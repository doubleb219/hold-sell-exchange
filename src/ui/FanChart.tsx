import { useMemo, useRef, useState } from 'react';
import type { Band } from '../engine/montecarlo';
import type { Strategy } from '../engine/types';
import { STRATEGY_LABEL } from '../engine/brief';
import { money, ticks } from './format';

const W = 760;
const H = 340;
const M = { t: 16, r: 108, b: 30, l: 56 };

interface Props {
  years: number[];
  bands: Record<Strategy, Band>;
  visible: Strategy[];
  focus: Strategy;
  decisionYear: number;
  base?: Record<Strategy, number[]>;
}

export function FanChart({ years, bands, visible, focus, decisionYear, base }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  const { x, y, yt } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of visible) {
      for (const v of bands[s].p10) lo = Math.min(lo, v);
      for (const v of bands[s].p90) hi = Math.max(hi, v);
    }
    lo = Math.min(0, lo);
    const yt = ticks(lo, hi, 5);
    const y0 = Math.min(lo, yt[0]);
    const y1 = Math.max(hi, yt[yt.length - 1]);
    const x = (i: number) => M.l + (i / (years.length - 1)) * (W - M.l - M.r);
    const y = (v: number) => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);
    return { x, y, yt };
  }, [bands, visible, years]);

  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = (b: Band) =>
    `${b.p90.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}${b.p10
      .map((_, k) => {
        const i = b.p10.length - 1 - k;
        return `L${x(i).toFixed(1)},${y(b.p10[i]).toFixed(1)}`;
      })
      .join('')}Z`;

  // Direct end-labels, nudged apart so they never collide.
  const labels = visible
    .map((s) => ({ s, y: y(bands[s].p50.at(-1)!) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 26) labels[i].y = labels[i - 1].y + 26;

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - M.l) / (W - M.l - M.r)) * (years.length - 1));
    setHover(i >= 0 && i < years.length ? i : null);
  };

  // points[0] is today (end of startYear − 1); the transaction happens in January right after points[decisionYear].
  const di = decisionYear < years.length ? decisionYear : -1;

  return (
    <div className="chart-wrap">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Wealth over time by strategy: median with 10th to 90th percentile band"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        style={{ touchAction: 'none', display: 'block' }}
      >
        {yt.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
            <text x={M.l - 8} y={y(v) + 4} textAnchor="end">
              {money(v)}
            </text>
          </g>
        ))}
        {years.map((yr, i) =>
          i % Math.ceil(years.length / 10) === 0 || i === years.length - 1 ? (
            <text key={yr} x={x(i)} y={H - 8} textAnchor="middle">
              {i === 0 ? 'Today' : yr}
            </text>
          ) : null,
        )}
        {di >= 0 && (
          <g>
            <line x1={x(di)} x2={x(di)} y1={M.t} y2={H - M.b} stroke="var(--axis)" strokeDasharray="3 4" />
            <text x={x(di) + 6} y={M.t + 10}>
              Transaction
            </text>
          </g>
        )}
        {visible.includes(focus) && <path d={area(bands[focus])} fill={`var(--${focus})`} opacity={0.16} />}
        {visible.map((s) => (
          <path key={s} d={line(bands[s].p50)} fill="none" stroke={`var(--${s})`} strokeWidth={s === focus ? 2.5 : 2} strokeLinejoin="round" />
        ))}
        {base &&
          visible.map((s) => (
            <path key={`b-${s}`} d={line(base[s])} fill="none" stroke={`var(--${s})`} strokeWidth={1} strokeDasharray="2 3" opacity={0.8} />
          ))}
        {labels.map(({ s, y: ly }) => (
          <g key={s}>
            <circle cx={W - M.r + 8} cy={ly} r={4} fill={`var(--${s})`} />
            <text x={W - M.r + 16} y={ly - 2} className="ink">
              {STRATEGY_LABEL[s]}
            </text>
            <text x={W - M.r + 16} y={ly + 11}>
              {money(bands[s].p50.at(-1)!)}
            </text>
          </g>
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={H - M.b} stroke="var(--ink-2)" strokeWidth={1} />
            {visible.map((s) => (
              <circle key={s} cx={x(hover)} cy={y(bands[s].p50[hover])} r={4} fill={`var(--${s})`} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="tip"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            top: 8,
            transform: x(hover) > W * 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
          }}
        >
          <div className="h">{hover === 0 ? 'Today' : `End of ${years[hover]}`}</div>
          {visible.map((s) => (
            <div key={s}>
              <div className="r">
                <span>
                  <i className="sw" style={{ width: 8, height: 8, borderRadius: 2, background: `var(--${s})`, display: 'inline-block' }} />
                  {STRATEGY_LABEL[s]}
                </span>
                <b>{money(bands[s].p50[hover])}</b>
              </div>
              <div className="sub" style={{ textAlign: 'right' }}>
                P10 {money(bands[s].p10[hover])} · P90 {money(bands[s].p90[hover])}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
