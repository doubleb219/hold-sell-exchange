import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultAssumptions, sampleHousehold } from './engine/sample';
import { reconcile, fieldLabel } from './engine/reconcile';
import { breakevenGrid, runBaseCase, runMonteCarlo } from './engine/montecarlo';
import { watchlist } from './engine/watchlist';
import { initPropertyState } from './engine/simulate';
import { advisorBrief, STRATEGY_LABEL } from './engine/brief';
import { describeLoan } from './engine/loans';
import { STRATEGIES, type Assumptions, type Lens, type Property, type SourceTag, type Strategy } from './engine/types';
import type { WorkerRequest, WorkerResponse } from './worker';
import { FanChart } from './ui/FanChart';
import { Waterfall } from './ui/Waterfall';
import { Heatmap } from './ui/Heatmap';
import { money, pct, usd } from './ui/format';

const SOURCE_LABEL: Record<SourceTag['kind'], string> = {
  tax_return: 'Tax return',
  closing_statement: 'Closing stmt',
  lender_statement: 'Lender stmt',
  owner_asserted: 'Owner said',
  estimate: 'Estimate',
  derived: 'Derived',
};

const STATE_PRESETS: { label: string; rate: number }[] = [
  { label: 'California (9.3%)', rate: 0.093 },
  { label: 'New York (6.85%)', rate: 0.0685 },
  { label: 'Oregon (9.9%)', rate: 0.099 },
  { label: 'Colorado (4.4%)', rate: 0.044 },
  { label: 'Texas / Florida / WA (0%)', rate: 0 },
];

export default function App() {
  // `#demo` pre-resolves the conflicts (2024 return, lender statement) for a one-click tour.
  const [resolutions, setResolutions] = useState<Record<string, string>>((): Record<string, string> =>
    typeof location !== 'undefined' && location.hash === '#demo'
      ? { 'oakland.accumulatedDepreciation': 'oak-dep-2024', 'sacramento.loanBalance:sac-heloc': 'sac-heloc-lender' }
      : {},
  );
  const [a, setA] = useState<Assumptions>(defaultAssumptions);
  const [wages, setWages] = useState(sampleHousehold.wages);
  const [stateRate, setStateRate] = useState(sampleHousehold.stateRate);
  const [lens, setLens] = useState<Lens>('liquidation');
  const [visible, setVisible] = useState<Strategy[]>([...STRATEGIES]);
  const [focus, setFocus] = useState<Strategy>('exchange');
  const [ledgerStrategy, setLedgerStrategy] = useState<Strategy>('exchange');
  const [paths, setPaths] = useState(300);
  const [seed, setSeed] = useState(2026);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const household = useMemo(() => ({ ...sampleHousehold, wages, stateRate }), [wages, stateRate]);
  const rec = useMemo(() => reconcile(household, resolutions), [household, resolutions]);
  const ready = rec.conflicts.length === 0;
  const subject = household.properties.find((p) => p.id === a.subjectId)!;

  const base = useMemo(() => (ready ? runBaseCase(rec.household, a) : null), [ready, rec.household, a]);
  const watch = useMemo(() => watchlist(rec.household, a), [rec.household, a]);

  // Monte Carlo runs off the main thread.
  const worker = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const [mc, setMc] = useState<WorkerResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [workerOk, setWorkerOk] = useState(true);
  useEffect(() => {
    try {
      worker.current = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch {
      setWorkerOk(false);
      return;
    }
    worker.current.onerror = (err) => {
      console.error('Simulation worker failed; falling back to main thread', err);
      setWorkerOk(false);
    };
    worker.current.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.id === reqId.current) {
        setMc(e.data);
        setBusy(false);
      }
    };
    return () => worker.current?.terminate();
  }, []);
  useEffect(() => {
    if (!ready) return;
    const id = ++reqId.current;
    setBusy(true);
    const t = setTimeout(() => {
      const msg: WorkerRequest = { id, household: rec.household, assumptions: a, paths, seed };
      if (workerOk && worker.current) worker.current.postMessage(msg);
      else {
        const t0 = performance.now();
        const res = runMonteCarlo(msg.household, msg.assumptions, msg.paths, msg.seed);
        const grid = { liquidation: breakevenGrid(msg.household, msg.assumptions, 'liquidation'), heirs: breakevenGrid(msg.household, msg.assumptions, 'heirs') };
        setMc({ id, mc: res, grid, ms: performance.now() - t0 });
        setBusy(false);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [ready, rec.household, a, paths, seed, workerOk]);

  const brief = useMemo(
    () =>
      base
        ? advisorBrief(base, mc?.mc ?? null, Object.values(rec.facts), household.startYear + a.horizonYears - 1, (key) => {
            const [pid, field] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
            const p = household.properties.find((x) => x.id === pid);
            return `${p?.name ?? pid} ${fieldLabel(field as never, p).toLowerCase()}`;
          })
        : [],
    [base, mc, rec.facts, household.startYear, a.horizonYears],
  );

  const setM = (k: keyof Assumptions['market'], v: number) => setA((x) => ({ ...x, market: { ...x.market, [k]: v } }));
  const setR = (k: keyof Assumptions['replacement'], v: number) => setA((x) => ({ ...x, replacement: { ...x.replacement, [k]: v } }));
  const endYear = household.startYear + a.horizonYears - 1;
  const txYear = household.startYear + a.decisionYear;

  return (
    <div className="wrap">
      <header className="top">
        <div className="theme-toggle seg" role="group" aria-label="Theme">
          {(['light', 'dark'] as const).map((t) => (
            <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
              {t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <p className="eyebrow">Real estate decision simulator</p>
        <h1>Hold · Sell · Exchange</h1>
        <p>
          A client's rentals are often a third of their net worth, and the decision to hold, sell, or 1031-exchange them gets made in a
          spreadsheet. This engine runs that decision month by month over {a.horizonYears} years and thousands of possible markets, with the tax
          computed to the dollar: MACRS depreciation, §1250 recapture, 0/15/20% stacking, NIIT, §469 passive losses, and 1031 basis carryover.
          It won't run on a number nobody has stood behind.
        </p>
      </header>

      {/* 1 — DATA */}
      <section className="block">
        <h2>1 · The household, from its documents</h2>
        <p className="lede">
          {household.name}: married filing jointly, {usd(wages)} wages, four rentals. Every figure carries its source. Click a property to make it the
          one you're deciding on.
        </p>
        <div className="props">
          {rec.household.properties.map((p) => (
            <PropertyCard key={p.id} p={p} facts={rec.facts} selected={p.id === a.subjectId} onSelect={() => setA((x) => ({ ...x, subjectId: p.id }))} />
          ))}
        </div>
      </section>

      <section className="block">
        <h2>2 · Reconcile before you compute</h2>
        <p className="lede">
          The same property reads differently in different documents. The engine won't average them. It waits until you choose the source
          you'll defend in front of the client.
        </p>
        {rec.conflicts.length === 0 && Object.values(rec.facts).some((f) => f.status === 'chosen') && (
          <p className="ok-note">✓ All facts reconciled. Your choices are recorded in the advisor brief.</p>
        )}
        <div className="grid2">
          {sampleHousehold.observations
            .reduce<string[]>((ks, o) => {
              const k = `${o.propertyId}.${o.field}`;
              const n = sampleHousehold.observations.filter((x) => `${x.propertyId}.${x.field}` === k);
              const distinct = new Set(n.map((x) => x.value)).size > 1;
              return distinct && !ks.includes(k) ? [...ks, k] : ks;
            }, [])
            .map((k) => {
              const opts = sampleHousehold.observations.filter((o) => `${o.propertyId}.${o.field}` === k);
              const p = household.properties.find((x) => x.id === opts[0].propertyId)!;
              const unresolved = rec.conflicts.some((c) => c.key === k);
              return (
                <div key={k} className="card conflict" style={{ borderLeftColor: unresolved ? undefined : 'var(--exchange)' }}>
                  <h3>
                    {p.name}: {fieldLabel(opts[0].field, p)}
                  </h3>
                  <p className="why">
                    {unresolved ? 'Sources disagree. Pick the one you can stand behind.' : 'Resolved.'} Difference:{' '}
                    {usd(Math.max(...opts.map((o) => o.value)) - Math.min(...opts.map((o) => o.value)))}.
                  </p>
                  {opts.map((o) => (
                    <label key={o.id} className="opt">
                      <input type="radio" name={k} checked={resolutions[k] === o.id} onChange={() => setResolutions((r) => ({ ...r, [k]: o.id }))} />
                      <span>
                        <span className="v">{usd(o.value)}</span> <span className="src">{SOURCE_LABEL[o.source.kind]}</span>
                        <div className="d">{o.source.document}</div>
                        {o.note && <div className="d" style={{ color: 'var(--muted)' }}>{o.note}</div>}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })}
        </div>
      </section>

      <section className="block">
        <h2>3 · Watchlist</h2>
        <p className="lede">What changes for this household before the client calls about it. Computed on the expected rate path.</p>
        <div className="card">
          <ul className="watch">
            {watch.map((w, i) => (
              <li key={i}>
                <span className={`sev ${w.severity}`}>{w.severity}</span>
                <div>
                  <div className="t">
                    {w.title} <span className="m">· {w.propertyName}{w.when ? ` · ${w.when}` : ''}</span>
                  </div>
                  <div className="m">{w.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 2 — DECISION */}
      <section className="block">
        <h2>4 · The decision</h2>
        <p className="lede">
          What to do with <b>{subject.name}</b> in January {txYear}: hold it, sell it and invest the proceeds, or exchange into a larger property at{' '}
          {pct(a.replacement.ltv)} LTV. The other three properties are held in every scenario.
        </p>
        <div className="card controls">
          <Slider label="Transaction year" value={a.decisionYear} min={1} max={Math.min(10, a.horizonYears - 1)} step={1} fmt={(v) => String(household.startYear + v)} onChange={(v) => setA((x) => ({ ...x, decisionYear: v }))} />
          <Slider label="Horizon" value={a.horizonYears} min={10} max={30} step={5} fmt={(v) => `${v} yrs → ${household.startYear + v - 1}`} onChange={(v) => setA((x) => ({ ...x, horizonYears: v, decisionYear: Math.min(x.decisionYear, v - 1) }))} />
          <Slider label="Expected appreciation" value={a.market.hpa} min={-0.01} max={0.07} step={0.005} fmt={(v) => `${pct(v, 1)}/yr`} onChange={(v) => setM('hpa', v)} />
          <Slider label="Appreciation volatility" value={a.market.hpaVol} min={0.01} max={0.12} step={0.01} fmt={(v) => pct(v)} onChange={(v) => setM('hpaVol', v)} />
          <Slider label="Replacement LTV" value={a.replacement.ltv} min={0} max={0.75} step={0.05} fmt={(v) => pct(v)} hint="0% = all-cash, which creates mortgage boot" onChange={(v) => setR('ltv', v)} />
          <Slider label="Replacement mortgage rate" value={a.replacement.rate} min={0.04} max={0.09} step={0.00125} fmt={(v) => pct(v, 3)} onChange={(v) => setR('rate', v)} />
          <Slider label="Replacement gross yield" value={a.replacement.grossYield} min={0.05} max={0.1} step={0.0025} fmt={(v) => pct(v, 2)} onChange={(v) => setR('grossYield', v)} />
          <Slider label="Portfolio return (sale proceeds)" value={a.market.equityReturn} min={0.03} max={0.1} step={0.005} fmt={(v) => pct(v, 1)} onChange={(v) => setM('equityReturn', v)} />
          <Slider label="Household wages" value={wages} min={60_000} max={800_000} step={5_000} fmt={money} hint="Drives brackets, NIIT, and the $25k allowance" onChange={setWages} />
          <div className="ctl">
            <label>State</label>
            <select value={stateRate} onChange={(e) => setStateRate(Number(e.target.value))}>
              {STATE_PRESETS.map((s) => (
                <option key={s.label} value={s.rate}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="hint">Flat marginal rate on AGI (simplification)</div>
          </div>
          <div className="ctl">
            <label>Simulated markets</label>
            <select value={paths} onChange={(e) => setPaths(Number(e.target.value))}>
              {[100, 300, 1000].map((n) => (
                <option key={n} value={n}>
                  {n} paths
                </option>
              ))}
            </select>
          </div>
          <div className="ctl">
            <label>
              Seed <b>{seed}</b>
            </label>
            <button className="pill" onClick={() => setSeed((s) => (s * 48271) % 2147483647)}>
              Reroll markets
            </button>
            <div className="hint">Same seed → identical results</div>
          </div>
        </div>
      </section>

      {/* 3 — RESULTS */}
      {!ready ? (
        <section className="block">
          <div className="blocked">
            <strong>
              {rec.conflicts.length} unreconciled fact{rec.conflicts.length > 1 ? 's' : ''}. The engine won't run.
            </strong>
            {rec.conflicts.map((c) => `${c.propertyName}: ${c.label}`).join(' · ')}. Resolve them in section 2.
          </div>
        </section>
      ) : (
        base && (
          <>
            <section className="block">
              <h2>5 · Outcomes</h2>
              <p className="lede">
                Each line is the median outcome across {mc?.mc.paths ?? paths} simulated markets. The shaded band is the 10th to 90th
                percentile, and the dotted line is the expected path. Every strategy sees the same markets, so the gaps between them come from the
                decision, not from luck.
              </p>
              <div className="toolbar">
                <div className="seg" role="group" aria-label="Valuation lens">
                  <button aria-pressed={lens === 'liquidation'} onClick={() => setLens('liquidation')}>
                    Sell everything in {endYear}
                  </button>
                  <button aria-pressed={lens === 'heirs'} onClick={() => setLens('heirs')}>
                    Pass to heirs (step-up)
                  </button>
                </div>
                <div className="legend" role="group" aria-label="Strategies">
                  {STRATEGIES.map((s) => (
                    <button
                      key={s}
                      className="pill"
                      aria-pressed={visible.includes(s)}
                      onClick={() => {
                        setVisible((v) => (v.includes(s) ? (v.length > 1 ? v.filter((x) => x !== s) : v) : STRATEGIES.filter((x) => v.includes(x) || x === s)));
                        setFocus(s);
                      }}
                    >
                      <i className="sw" style={{ background: `var(--${s})` }} />
                      {STRATEGY_LABEL[s]}
                    </button>
                  ))}
                </div>
                <span className="note">{busy ? <><span className="spinner" /> simulating…</> : mc ? `${mc.mc.paths} paths in ${Math.round(mc.ms)} ms` : ''}</span>
              </div>
              <div className="card">
                {mc ? (
                  <FanChart
                    years={mc.mc.years}
                    bands={{ hold: mc.mc.bands.hold[lens], sell: mc.mc.bands.sell[lens], exchange: mc.mc.bands.exchange[lens] }}
                    visible={visible}
                    focus={visible.includes(focus) ? focus : visible[0]}
                    decisionYear={a.decisionYear}
                    base={{
                      hold: base.hold.points.map((p) => p[lens]),
                      sell: base.sell.points.map((p) => p[lens]),
                      exchange: base.exchange.points.map((p) => p[lens]),
                    }}
                  />
                ) : (
                  <div className="blocked">
                    <span className="spinner" /> Simulating markets…
                  </div>
                )}
              </div>
              {mc && (
                <div className="grid3" style={{ marginTop: 12 }}>
                  {STRATEGIES.map((s) => (
                    <div key={s} className="card stat">
                      <div className="k">
                        <i className="sw" style={{ width: 10, height: 10, borderRadius: 2, background: `var(--${s})`, display: 'inline-block' }} />
                        {STRATEGY_LABEL[s]} finishes richest
                      </div>
                      <div className="v">{pct(mc.mc.winRate[lens][s])}</div>
                      <div className="s">
                        of markets · median {money(mc.mc.bands[s][lens].p50.at(-1)!)} · P10 {money(mc.mc.bands[s][lens].p10.at(-1)!)}
                      </div>
                      <div className="bar">
                        <i style={{ width: pct(mc.mc.winRate[lens][s]), background: `var(--${s})` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="block">
              <h2>6 · Advisor brief</h2>
              <p className="lede">Written from the ledger by a deterministic template. Every sentence traces back to a number below.</p>
              <div className="card brief">
                {brief.map((b) => (
                  <div key={b.heading}>
                    <h3>{b.heading}</h3>
                    <p>{b.body}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="block">
              <h2>7 · The transaction, line by line</h2>
              <p className="lede">Expected-path numbers for January {txYear}. Tax is the incremental federal + state tax caused by this transaction alone.</p>
              <div className="grid2">
                {(['sell', 'exchange'] as const).map((s) => {
                  const t = base[s].transaction!;
                  return (
                    <div key={s} className="card">
                      <h3 style={{ margin: '0 0 8px', fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <i style={{ width: 10, height: 10, borderRadius: 2, background: `var(--${s})`, display: 'inline-block' }} />
                        {STRATEGY_LABEL[s]}: {usd(t.taxImpact.total)} tax, {s === 'sell' ? `${usd(t.netCash)} cash` : `${usd(t.deferredGain!)} deferred`}
                      </h3>
                      <Waterfall t={t} color={`var(--${s})`} />
                    </div>
                  );
                })}
              </div>
              <div className="card" style={{ marginTop: 12 }}>
                <TransactionTable sell={base.sell.transaction!} ex={base.exchange.transaction!} />
              </div>
            </section>

            <section className="block">
              <h2>8 · Where the answer flips</h2>
              <p className="lede">
                Exchange minus sell, in {lens === 'heirs' ? 'value to heirs' : 'after-tax liquidation value'} at {endYear}, across appreciation
                assumptions and transaction years. The heatmap shows how much the recommendation depends on the market call, which a single
                spreadsheet scenario can't show.
              </p>
              <div className="card">{mc && <Heatmap g={mc.grid[lens]} currentHpa={a.market.hpa} currentYear={a.decisionYear} startYear={household.startYear} />}</div>
            </section>

            <section className="block">
              <h2>9 · Year by year</h2>
              <div className="toolbar">
                <div className="seg" role="group" aria-label="Ledger strategy">
                  {STRATEGIES.map((s) => (
                    <button key={s} aria-pressed={ledgerStrategy === s} onClick={() => setLedgerStrategy(s)}>
                      {STRATEGY_LABEL[s]}
                    </button>
                  ))}
                </div>
                <span className="note">Whole portfolio, expected path. Highlighted row = transaction year.</span>
              </div>
              <div className="card scroll">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th>Rent collected</th>
                      <th>Operating exp.</th>
                      <th>Interest</th>
                      <th>Depreciation</th>
                      <th>Net passive</th>
                      <th>Suspended (end)</th>
                      <th>§1250 gain</th>
                      <th>Cap. gains + div.</th>
                      <th>Tax from RE + portfolio</th>
                      <th>Pre-tax cash flow</th>
                      <th>After-tax liquidation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {base[ledgerStrategy].ledgers.map((l, i) => (
                      <tr key={l.year} className={l.year === txYear && ledgerStrategy !== 'hold' ? 'hl' : ''}>
                        <td>{l.year}</td>
                        <td>{usd(l.effectiveRent)}</td>
                        <td>{usd(l.operatingExpenses)}</td>
                        <td>{usd(l.interest)}</td>
                        <td>{usd(l.depreciation)}</td>
                        <td className={l.netPassive < 0 ? 'neg' : ''}>{usd(l.netPassive)}</td>
                        <td>{usd(l.suspendedEnding)}</td>
                        <td>{usd(l.unrecaptured1250)}</td>
                        <td>{usd(l.capitalGain)}</td>
                        <td>{usd(l.attributableTax)}</td>
                        <td>{usd(l.preTaxCashFlow)}</td>
                        <td>{usd(base[ledgerStrategy].points[i + 1].liquidation)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )
      )}

      <footer>
        Fictional household. Federal brackets are exact for 2025 and indexed after that by the assumed {pct(a.market.inflation, 1)} inflation. NIIT
        and §469 thresholds are statutory and not indexed. State tax is a flat marginal rate. Not tax advice. Engine and tests are on{' '}
        <a href="https://github.com/doubleb219/hold-sell-exchange">GitHub</a>.
      </footer>
    </div>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; hint?: string; onChange: (v: number) => void }) {
  return (
    <div className="ctl">
      <label>
        {props.label} <b>{props.fmt(props.value)}</b>
      </label>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} aria-label={props.label} />
      {props.hint && <div className="hint">{props.hint}</div>}
    </div>
  );
}

function PropertyCard({ p, facts, selected, onSelect }: { p: Property; facts: ReturnType<typeof reconcile>['facts']; selected: boolean; onSelect: () => void }) {
  const debt = p.loans.reduce((s, l) => s + l.balance, 0);
  const dep = facts[`${p.id}.accumulatedDepreciation`];
  const src = (k: string) => {
    const s = p.sources[k];
    return s ? <span className="src" title={s.document}>{SOURCE_LABEL[s.kind]}</span> : null;
  };
  return (
    <button className="prop" aria-pressed={selected} onClick={onSelect}>
      {selected && <span className="subject-tag">Deciding</span>}
      <h3>{p.name}</h3>
      <div className="loc">
        {p.kind} · {p.location} · since {p.placedInService.year}
      </div>
      <dl className="kv">
        <dt>Value</dt>
        <dd>
          {money(p.currentValue)}
          {src('currentValue')}
        </dd>
        <dt>Paid</dt>
        <dd>
          {money(p.purchasePrice)}
          {src('purchasePrice')}
        </dd>
        <dt>Depreciation</dt>
        <dd>
          {money(dep ? dep.value : initPropertyState(p, sampleHousehold.startYear).depTaken)}
          {dep ? (
            <span className={`src ${dep.status === 'chosen' ? 'chosen' : ''}`} title={dep.source.document}>
              {dep.status === 'chosen' ? 'You chose' : SOURCE_LABEL[dep.source.kind]}
            </span>
          ) : (
            <span className="src">Schedule</span>
          )}
        </dd>
        <dt>Debt</dt>
        <dd>{money(debt)}</dd>
        <dt>Rent</dt>
        <dd>{usd(p.monthlyRent)}/mo</dd>
        <dt>Suspended loss</dt>
        <dd>{money(p.suspendedLoss)}</dd>
      </dl>
      <ul className="loans">
        {p.loans.map((l) => (
          <li key={l.id}>
            <b>{l.label}</b>
            {l.balance > 0 ? ` · ${money(l.balance)}` : ''} — {describeLoan(l)}
          </li>
        ))}
      </ul>
    </button>
  );
}

function TransactionTable({ sell, ex }: { sell: NonNullable<ReturnType<typeof runBaseCase>['sell']['transaction']>; ex: NonNullable<ReturnType<typeof runBaseCase>['exchange']['transaction']> }) {
  const rows: [string, number | null, number | null, string][] = [
    ['Sale price', sell.price, ex.price, 'Expected-path market value in the transaction month'],
    ['− Selling & exchange costs', -(sell.sellingCosts + sell.exchangeCosts), -(ex.sellingCosts + ex.exchangeCosts), 'Commission, transfer tax, escrow; QI fee on an exchange'],
    ['= Amount realized', sell.amountRealized, ex.amountRealized, 'IRC §1001(b)'],
    ['Cost basis', sell.costBasis, ex.costBasis, 'Purchase price (closing statement) + capital improvements'],
    ['− Depreciation taken', -sell.depreciationTaken, -ex.depreciationTaken, 'Reconciled prior depreciation + MACRS 27.5-yr mid-month since, incl. the half month of disposition'],
    ['= Adjusted basis', sell.adjustedBasis, ex.adjustedBasis, 'IRC §1016'],
    ['Realized gain', sell.realizedGain, ex.realizedGain, 'Amount realized − adjusted basis'],
    ['Mortgage boot', null, ex.boot ?? 0, 'Debt relieved minus new debt taken on (Reg. §1.1031(d)-2)'],
    ['Recognized gain', sell.realizedGain, ex.recognizedGain ?? 0, 'All of it on a sale; only boot on an exchange'],
    ['  of which unrecaptured §1250', sell.unrecaptured1250, ex.unrecaptured1250, 'Lesser of gain or depreciation taken, taxed at ordinary rates capped at 25%'],
    ['  of which long-term capital gain', sell.capitalGain, ex.capitalGain, 'Stacked above §1250 gain at 0/15/20%'],
    ['Deferred gain', 0, ex.deferredGain ?? 0, 'Carried into the replacement through a reduced basis'],
    ['Suspended losses released', sell.suspendedReleased, 0, '§469(g): a fully taxable sale frees them; an exchange does not'],
    ['Suspended losses carried', 0, ex.suspendedCarried, 'Carried into the replacement property'],
    ['Federal tax: §1250', sell.taxImpact.recapture1250, ex.taxImpact.recapture1250, ''],
    ['Federal tax: capital gains', sell.taxImpact.capitalGains, ex.taxImpact.capitalGains, ''],
    ['Federal tax: ordinary (released losses)', sell.taxImpact.ordinary, ex.taxImpact.ordinary, 'Negative = tax saved'],
    ['NIIT', sell.taxImpact.niit, ex.taxImpact.niit, '3.8% × lesser of NII or MAGI over $250k'],
    ['State', sell.taxImpact.state, ex.taxImpact.state, 'Flat marginal rate'],
    ['Total tax from this transaction', sell.taxImpact.total, ex.taxImpact.total, 'With minus without the transaction, same year, same household'],
    ['Loan payoff', sell.loanPayoff, ex.loanPayoff, ''],
    ['Replacement price / new debt', null, ex.replacementPrice ?? 0, `Equity ÷ (1 − LTV); new debt ${usd(ex.replacementDebt ?? 0)}`],
    ['Replacement basis', null, ex.replacementBasis ?? 0, 'Replacement price − deferred gain'],
    ['  exchanged basis (old schedule)', null, ex.carryoverDepreciableBasis ?? 0, 'Reg. §1.168(i)-6: keeps depreciating over the relinquished property’s remaining life'],
    ['  excess basis (new 27.5 yr)', null, ex.excessDepreciableBasis ?? 0, 'Placed in service at the exchange'],
    ['Cash to client after tax', sell.netCash, 0, ''],
  ];
  return (
    <div className="scroll" style={{ maxHeight: 'none' }}>
      <table className="ledger">
        <thead>
          <tr>
            <th>Line</th>
            <th>Sell</th>
            <th>Exchange</th>
            <th style={{ textAlign: 'left' }}>Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, s, e, why]) => (
            <tr key={label} className={label.startsWith('Total') ? 'total' : ''}>
              <td>{label}</td>
              <td>{s === null ? '—' : usd(s)}</td>
              <td>{e === null ? '—' : usd(e)}</td>
              <td className="why">{why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
