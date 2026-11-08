import { useState } from 'react';
import type { BreakevenGrid } from '../engine/montecarlo';
import { money, pct, usd } from './format';

/** Diverging fill: exchange-better (aqua) ↔ sell-better (orange) around a neutral gray, by |Δ| on a sqrt scale. */
function fill(v: number, max: number): string {
  const t = Math.min(1, Math.sqrt(Math.abs(v) / max));
  const pole = v >= 0 ? 'var(--exchange)' : 'var(--sell)';
  return `color-mix(in oklab, ${pole} ${Math.round(t * 100)}%, var(--neutral-mid))`;
}

export function Heatmap({ g, currentHpa, currentYear, startYear }: { g: BreakevenGrid; currentHpa: number; currentYear: number; startYear: number }) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const max = Math.max(1, ...g.cells.flat().map(Math.abs));
  const cols = g.decisionYears.length;
  const nearestRow = g.appreciation.reduce((b, v, i) => (Math.abs(v - currentHpa) < Math.abs(g.appreciation[b] - currentHpa) ? i : b), 0);
  return (
    <div className="chart-wrap">
      <div style={{ display: 'grid', gridTemplateColumns: `64px repeat(${cols}, minmax(0,1fr))`, gap: 2, fontSize: 12 }}>
        <div />
        {g.decisionYears.map((d) => (
          <div key={d} style={{ textAlign: 'center', color: 'var(--muted)', paddingBottom: 4 }}>
            {startYear + d}
          </div>
        ))}
        {g.appreciation.map((hpa, i) => (
          <Row key={hpa}>
            <div style={{ color: 'var(--muted)', textAlign: 'right', paddingRight: 8, alignSelf: 'center' }}>{pct(hpa)}/yr</div>
            {g.cells[i].map((v, j) => {
              const current = i === nearestRow && g.decisionYears[j] === currentYear;
              const strong = Math.sqrt(Math.abs(v) / max) > 0.6;
              return (
                <div
                  key={j}
                  onPointerEnter={() => setHover([i, j])}
                  onPointerLeave={() => setHover(null)}
                  style={{
                    background: fill(v, max),
                    borderRadius: 4,
                    height: 34,
                    display: 'grid',
                    placeItems: 'center',
                    fontVariantNumeric: 'tabular-nums',
                    color: strong ? '#fff' : 'var(--ink)',
                    outline: current ? '2px solid var(--ink)' : hover && hover[0] === i && hover[1] === j ? '1px solid var(--ink-2)' : 'none',
                    outlineOffset: -1,
                    cursor: 'default',
                    fontSize: 11,
                  }}
                >
                  {(v >= 0 ? '+' : '') + money(v)}
                </div>
              );
            })}
          </Row>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: 'var(--ink-2)', gap: 12, flexWrap: 'wrap' }}>
        <span>
          <i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'var(--sell)', marginRight: 6 }} />
          Selling ends richer
        </span>
        <span style={{ color: 'var(--muted)' }}>Rows: assumed appreciation · Columns: year of the transaction · Outlined: current settings</span>
        <span>
          Exchanging ends richer
          <i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'var(--exchange)', marginLeft: 6 }} />
        </span>
      </div>
      {hover && (
        <div className="tip" style={{ right: 0, top: -8 }}>
          <div className="h">
            Transact in {startYear + g.decisionYears[hover[1]]}, {pct(g.appreciation[hover[0]])}/yr appreciation
          </div>
          <div className="r">
            <span>Exchange − Sell</span>
            <b>{usd(g.cells[hover[0]][hover[1]])}</b>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
