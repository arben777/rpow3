import { useEffect, useMemo, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { LedgerResponse, UserGrowthPoint } from '@rpow/shared';

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}m ${r}s`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return `${d}d ${h}h`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtUtcHHMM(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function fmtUtcDate(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
}
function fmtUtcFull(t: number): string {
  return `${fmtUtcHHMM(t)} UTC ${fmtUtcDate(t)}`;
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (max <= min) return [min];
  const range = max - min;
  const rough = range / count;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = norm >= 7.5 ? 10 * pow : norm >= 3 ? 5 * pow : norm >= 1.5 ? 2 * pow : pow;
  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

interface Fit {
  a: number;
  b: number;          // /hour
  r2: number;
  doublingHours: number | null;
  ms0: number;        // anchor (first signup ms)
}

function expFit(points: UserGrowthPoint[], firstSignupMs: number | null): Fit | null {
  if (points.length < 2) return null;
  const ms0 = firstSignupMs ?? new Date(points[0]!.at).getTime();
  const ts: number[] = [];
  const lns: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    const tHours = (new Date(p.at).getTime() - ms0) / 3600000;
    if (p.users <= 0) continue;
    ts.push(tHours);
    lns.push(Math.log(p.users));
    ys.push(p.users);
  }
  if (ts.length < 2) return null;
  const meanT = ts.reduce((s, v) => s + v, 0) / ts.length;
  const meanL = lns.reduce((s, v) => s + v, 0) / lns.length;
  let num = 0, den = 0;
  for (let i = 0; i < ts.length; i++) {
    num += (ts[i]! - meanT) * (lns[i]! - meanL);
    den += (ts[i]! - meanT) ** 2;
  }
  if (den === 0) return null;
  const b = num / den;
  const a = Math.exp(meanL - b * meanT);
  // R² in original (linear) y space — what people read as "fit quality" on the chart.
  const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < ts.length; i++) {
    const yhat = a * Math.exp(b * ts[i]!);
    ssRes += (ys[i]! - yhat) ** 2;
    ssTot += (ys[i]! - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  const doublingHours = b > 0 ? Math.log(2) / b : null;
  return { a, b, r2, doublingHours, ms0 };
}

function GrowthChart({ points, firstSignupAt }: { points: UserGrowthPoint[]; firstSignupAt: string | null }) {
  const fit = useMemo(
    () => expFit(points, firstSignupAt ? new Date(firstSignupAt).getTime() : null),
    [points, firstSignupAt],
  );

  if (points.length === 0) return <div className="dim">  (no signups yet)</div>;

  const W = 820, H = 360;
  const pad = { top: 16, right: 24, bottom: 44, left: 64 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const xs = points.map(p => new Date(p.at).getTime());
  const ys = points.map(p => p.users);
  const x0 = firstSignupAt ? Math.min(new Date(firstSignupAt).getTime(), xs[0]!) : xs[0]!;
  const x1 = xs[xs.length - 1]!;
  const yMaxRaw = Math.max(...ys, 1);
  // Add headroom; round to a nice tick.
  const yTicks = niceTicks(0, yMaxRaw * 1.05, 5);
  const yMax = yTicks[yTicks.length - 1]!;
  const xRange = Math.max(1, x1 - x0);

  const sx = (t: number) => pad.left + ((t - x0) / xRange) * innerW;
  const sy = (v: number) => pad.top + innerH - (v / yMax) * innerH;

  // Time ticks: 5 evenly-spaced positions across [x0, x1].
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => x0 + (i * xRange) / xTickCount);

  const dataPath = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${sx(xs[i]!).toFixed(1)},${sy(p.users).toFixed(1)}`,
  ).join(' ');

  let fitPath = '';
  if (fit) {
    const samples = 100;
    const segs: string[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = x0 + (xRange * i) / samples;
      const tHours = (t - fit.ms0) / 3600000;
      const y = fit.a * Math.exp(fit.b * tHours);
      segs.push(`${i === 0 ? 'M' : 'L'}${sx(t).toFixed(1)},${sy(Math.min(y, yMax * 1.5)).toFixed(1)}`);
    }
    fitPath = segs.join(' ');
  }

  // Annotation positions
  const firstMs = firstSignupAt ? new Date(firstSignupAt).getTime() : x0;
  const firstX = sx(firstMs);
  const firstY = sy(1);
  const lastP = points[points.length - 1]!;
  const lastMs = new Date(lastP.at).getTime();
  const lastX = sx(lastMs);
  const lastY = sy(lastP.users);

  // Info-box geometry (top-left, inside the plot)
  const infoX = pad.left + 14, infoY = pad.top + 14;
  const infoW = 260, infoH = 48;

  // Legend geometry (bottom-right, inside the plot)
  const legendW = 360, legendH = 50;
  const legendX = pad.left + innerW - legendW - 6;
  const legendY = pad.top + innerH - legendH - 6;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="user growth chart" style={{ display: 'block' }}>
      {/* y-axis grid */}
      {yTicks.map(y => (
        <line key={`gy-${y}`} x1={pad.left} y1={sy(y)} x2={pad.left + innerW} y2={sy(y)}
              stroke="var(--dimmer)" strokeWidth={1} opacity={0.35} />
      ))}
      {/* x-axis grid */}
      {xTicks.map((t, i) => (
        <line key={`gx-${i}`} x1={sx(t)} y1={pad.top} x2={sx(t)} y2={pad.top + innerH}
              stroke="var(--dimmer)" strokeWidth={1} opacity={0.2} />
      ))}

      {/* fit (dashed, behind actual) */}
      {fit && (
        <path d={fitPath} fill="none" stroke="var(--error)" strokeWidth={1.4}
              strokeDasharray="6 5" opacity={0.85} />
      )}
      {/* actual data */}
      <path d={dataPath} fill="none" stroke="var(--accent)" strokeWidth={1.8}
            strokeLinejoin="round" strokeLinecap="round" />

      {/* y-axis tick labels */}
      {yTicks.map(y => (
        <text key={`ty-${y}`} x={pad.left - 8} y={sy(y) + 4}
              fill="var(--dim)" fontSize={11} fontFamily="inherit" textAnchor="end">
          {y.toLocaleString()}
        </text>
      ))}
      {/* x-axis tick labels (UTC) */}
      {xTicks.map((t, i) => (
        <text key={`tx-${i}`} x={sx(t)} y={pad.top + innerH + 16}
              fill="var(--dim)" fontSize={11} fontFamily="inherit" textAnchor="middle">
          {fmtUtcHHMM(t)}
        </text>
      ))}
      {xTicks.map((t, i) => (
        <text key={`txd-${i}`} x={sx(t)} y={pad.top + innerH + 30}
              fill="var(--dim)" fontSize={10} fontFamily="inherit" textAnchor="middle" opacity={0.7}>
          {fmtUtcDate(t)}
        </text>
      ))}
      {/* axis titles */}
      <text x={pad.left + innerW / 2} y={H - 4}
            fill="var(--dim)" fontSize={11} fontFamily="inherit" textAnchor="middle">
        UTC time
      </text>
      <text x={14} y={pad.top + innerH / 2}
            fill="var(--dim)" fontSize={11} fontFamily="inherit" textAnchor="middle"
            transform={`rotate(-90 14 ${pad.top + innerH / 2})`}>
        cumulative users
      </text>

      {/* "first signup" annotation */}
      {firstSignupAt && (
        <g>
          <line x1={firstX + 1} y1={firstY - 1} x2={firstX + 36} y2={firstY - 30}
                stroke="var(--dim)" strokeWidth={0.8} />
          <circle cx={firstX} cy={firstY} r={2.5} fill="var(--accent)" />
          <text x={firstX + 40} y={firstY - 32} fill="var(--dim)" fontSize={11} fontFamily="inherit">
            first signup
          </text>
          <text x={firstX + 40} y={firstY - 18} fill="var(--dim)" fontSize={11} fontFamily="inherit">
            {fmtUtcFull(firstMs)}
          </text>
        </g>
      )}
      {/* "now" annotation */}
      <g>
        <line x1={lastX - 1} y1={lastY + 1} x2={lastX - 90} y2={lastY - 30}
              stroke="var(--accent-dim)" strokeWidth={0.8} />
        <circle cx={lastX} cy={lastY} r={3} fill="var(--accent)" />
        <text x={lastX - 94} y={lastY - 32} fill="var(--fg)" fontSize={11.5}
              fontFamily="inherit" fontWeight={600} textAnchor="end">
          now: {lastP.users.toLocaleString()} users
        </text>
        <text x={lastX - 94} y={lastY - 18} fill="var(--fg)" fontSize={11}
              fontFamily="inherit" textAnchor="end">
          {fmtUtcFull(lastMs)}
        </text>
      </g>

      {/* info box (top-left) */}
      {fit && (
        <g>
          <rect x={infoX} y={infoY} width={infoW} height={infoH}
                fill="rgba(0,0,0,0.55)" stroke="var(--accent-dim)" strokeWidth={1} rx={3} />
          <text x={infoX + 12} y={infoY + 20} fill="var(--accent)" fontSize={12} fontFamily="inherit">
            doubling time ≈ {fit.doublingHours != null ? `${fit.doublingHours.toFixed(2)} h` : '—'}
          </text>
          <text x={infoX + 12} y={infoY + 38} fill="var(--accent)" fontSize={12} fontFamily="inherit">
            fit slope b = {fit.b.toFixed(3)} /h
          </text>
        </g>
      )}

      {/* legend (bottom-right) */}
      {fit && (
        <g>
          <rect x={legendX} y={legendY} width={legendW} height={legendH}
                fill="rgba(0,0,0,0.55)" stroke="var(--accent-dim)" strokeWidth={1} rx={3} />
          <line x1={legendX + 12} y1={legendY + 16} x2={legendX + 36} y2={legendY + 16}
                stroke="var(--accent)" strokeWidth={1.8} />
          <text x={legendX + 44} y={legendY + 20} fill="var(--fg)" fontSize={11.5} fontFamily="inherit">
            actual users
          </text>
          <line x1={legendX + 12} y1={legendY + 36} x2={legendX + 36} y2={legendY + 36}
                stroke="var(--error)" strokeWidth={1.4} strokeDasharray="6 5" />
          <text x={legendX + 44} y={legendY + 40} fill="var(--fg)" fontSize={11.5} fontFamily="inherit">
            fit: y = {fit.a.toFixed(2)}·e^({fit.b.toFixed(3)}·t)  (R²={fit.r2.toFixed(3)})
          </text>
        </g>
      )}
    </svg>
  );
}

export function LedgerPage() {
  const [d, setD] = useState<LedgerResponse | null>(null);
  useEffect(() => { api.ledger().then(setD); }, []);
  if (!d) return <Panel title="PUBLIC LEDGER"><div>loading...</div></Panel>;
  const doublingLine = d.doubling_seconds === null
    ? '  DOUBLING TIME      : (need ≥ 2 users)'
    : `  DOUBLING TIME      : ${formatDuration(d.doubling_seconds)} (last ${Math.floor(d.user_count / 2)} → ${d.user_count} users)`;
  return (
    <>
      <Panel title="PUBLIC LEDGER">
        <pre style={{ margin: 0 }}>
{`  TOTAL MINTED        : ${d.total_minted}
  TOTAL TRANSFERRED   : ${d.total_transferred}
  CIRCULATING SUPPLY  : ${d.circulating_supply}
  CURRENT DIFFICULTY  : ${d.current_difficulty_bits} trailing zero bits
  USER COUNT          : ${d.user_count}
`}
        </pre>
        <div style={{ marginTop: 12 }} className="tagline">
          a modern tribute to a tribute to the original rpow by hal finney —
          <a href="https://nakamotoinstitute.org/finney/rpow/" target="_blank" rel="noreferrer"> finney's announcement</a>
        </div>
      </Panel>

      <Panel title="USER GROWTH">
        <pre style={{ margin: '0 0 8px' }}>
{`  USERS              : ${d.user_count}
${doublingLine}`}
        </pre>
        <GrowthChart points={d.user_growth} firstSignupAt={d.first_signup_at} />
      </Panel>
    </>
  );
}
