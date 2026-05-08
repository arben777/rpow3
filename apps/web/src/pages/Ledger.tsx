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
    return `${h}h ${String(m).padStart(2, '0')}m`;
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
function fmtUtcStamp(iso: string): string {
  const d = new Date(iso);
  const m = MONTHS[d.getUTCMonth()]!;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${m} ${day} ${hh}:${mm} UTC`;
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
  b: number;          // /hour — current instantaneous slope of ln(y)
  r2: number;
  doublingHours: number | null;
  ms0: number;        // anchor (first signup ms)
  windowFromMs: number; // earliest point used in the fit
}

/**
 * Weighted log-linear fit on the most recent `windowHours` of data.
 *
 * Two changes from a vanilla unweighted log-linear regression:
 *   - **Recent window**: only the last `windowHours` of points are used.
 *     The displayed value is the *current* doubling rate, not an average
 *     over the entire history. A flat early plateau won't drag it down.
 *   - **Weight by y_i**: each point's residual is weighted by its own
 *     user count. Late, large-y points dominate the slope; early,
 *     near-zero points still contribute but can't pull the curve flat.
 *
 * Falls back to all available points if fewer than 4 points fall inside
 * the window (early in a launch). Returns null when there's not enough
 * spread to define a slope.
 */
function expFit(
  points: UserGrowthPoint[],
  firstSignupMs: number | null,
  windowHours = 2,
): Fit | null {
  if (points.length < 2) return null;
  const ms0 = firstSignupMs ?? new Date(points[0]!.at).getTime();
  const lastMs = new Date(points[points.length - 1]!.at).getTime();
  const cutoffMs = lastMs - windowHours * 3600000;

  let recent = points.filter(p => new Date(p.at).getTime() >= cutoffMs && p.users > 0);
  if (recent.length < 4) recent = points.filter(p => p.users > 0);
  if (recent.length < 2) return null;

  const ts: number[] = [];
  const lns: number[] = [];
  const ys: number[] = [];
  for (const p of recent) {
    ts.push((new Date(p.at).getTime() - ms0) / 3600000);
    lns.push(Math.log(p.users));
    ys.push(p.users);
  }
  const ws = ys; // weight = users at the bucket
  const sumW = ws.reduce((s, w) => s + w, 0);
  if (sumW === 0) return null;
  const meanT = ts.reduce((s, t, i) => s + t * ws[i]!, 0) / sumW;
  const meanL = lns.reduce((s, l, i) => s + l * ws[i]!, 0) / sumW;
  let num = 0, den = 0;
  for (let i = 0; i < ts.length; i++) {
    num += ws[i]! * (ts[i]! - meanT) * (lns[i]! - meanL);
    den += ws[i]! * (ts[i]! - meanT) ** 2;
  }
  if (den === 0) return null;
  const b = num / den;
  const a = Math.exp(meanL - b * meanT);

  // R² in original (linear) y-space, computed on the same recent window.
  const meanY = ys.reduce((s, y) => s + y, 0) / ys.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < ts.length; i++) {
    const yhat = a * Math.exp(b * ts[i]!);
    ssRes += (ys[i]! - yhat) ** 2;
    ssTot += (ys[i]! - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  const doublingHours = b > 0 ? Math.log(2) / b : null;
  const windowFromMs = new Date(recent[0]!.at).getTime();
  return { a, b, r2, doublingHours, ms0, windowFromMs };
}

const MILESTONES = [1000, 2000, 5000, 10000, 50000, 100000] as const;

interface MilestoneRow {
  target: number;
  achievedAt: string | null;
  secondsFromPrevious: number | null;
  previousLabel: string;  // "launch" or "1,000", etc.
}

function computeMilestones(growth: UserGrowthPoint[], firstSignupAt: string | null): MilestoneRow[] {
  let prevMs = firstSignupAt ? new Date(firstSignupAt).getTime() : null;
  let prevLabel = 'launch';
  const rows: MilestoneRow[] = [];
  for (const target of MILESTONES) {
    const reached = growth.find(p => p.users >= target);
    if (reached) {
      const ms = new Date(reached.at).getTime();
      const sinceP = prevMs !== null ? Math.max(0, Math.floor((ms - prevMs) / 1000)) : null;
      rows.push({
        target,
        achievedAt: reached.at,
        secondsFromPrevious: sinceP,
        previousLabel: prevLabel,
      });
      prevMs = ms;
      prevLabel = target.toLocaleString();
    } else {
      rows.push({
        target,
        achievedAt: null,
        secondsFromPrevious: null,
        previousLabel: prevLabel,
      });
    }
  }
  return rows;
}

function MilestonesList({ rows }: { rows: MilestoneRow[] }) {
  // Column widths chosen so the longest "100,000 users" + longest duration align cleanly.
  const targetW = 14; // "100,000 users".length === 13 — pad to 14
  const durW = 10;
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
{rows.map(r => {
  const tag = r.achievedAt ? '[x]' : '[ ]';
  const target = `${r.target.toLocaleString()} users`.padEnd(targetW);
  const dur = r.secondsFromPrevious != null
    ? formatDuration(r.secondsFromPrevious).padEnd(durW)
    : 'pending'.padEnd(durW);
  const since = r.achievedAt
    ? `since ${r.previousLabel}`
    : `from ${r.previousLabel}`;
  return `  ${tag} ${target}  ${dur}  ${since}`;
}).join('\n')}
    </pre>
  );
}

function GrowthChart({
  points,
  firstSignupAt,
  fit,
}: {
  points: UserGrowthPoint[];
  firstSignupAt: string | null;
  fit: Fit | null;
}) {
  if (points.length === 0) return <div className="dim">  (no signups yet)</div>;

  const W = 820, H = 380;
  // Extra top padding so the "now" annotation has room when the curve peaks
  // at the top of the chart. Bottom padding leaves room for two-line dates.
  const pad = { top: 36, right: 24, bottom: 48, left: 64 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const xs = points.map(p => new Date(p.at).getTime());
  const ys = points.map(p => p.users);
  const x0 = firstSignupAt ? Math.min(new Date(firstSignupAt).getTime(), xs[0]!) : xs[0]!;
  const x1 = xs[xs.length - 1]!;
  const yMaxRaw = Math.max(...ys, 1);
  const yTicks = niceTicks(0, yMaxRaw * 1.05, 5);
  const yMax = yTicks[yTicks.length - 1]!;
  const xRange = Math.max(1, x1 - x0);

  const sx = (t: number) => pad.left + ((t - x0) / xRange) * innerW;
  const sy = (v: number) => pad.top + innerH - (v / yMax) * innerH;

  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => x0 + (i * xRange) / xTickCount);

  const dataPath = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${sx(xs[i]!).toFixed(1)},${sy(p.users).toFixed(1)}`,
  ).join(' ');

  // We deliberately don't draw the fit curve. Plotting y = a·e^(b·t) from
  // the regression always overshoots in the early flat plateau (the
  // intercept `a` is "what the curve would be at t=0 IF the current rate
  // had always held", not "where the curve actually started"). The number
  // people care about is the slope; that lives in the info box.

  // Annotation positions — smart-place "now" above or below depending on lastY.
  const firstMs = firstSignupAt ? new Date(firstSignupAt).getTime() : x0;
  const firstX = sx(firstMs);
  const firstY = sy(1);
  const lastP = points[points.length - 1]!;
  const lastMs = new Date(lastP.at).getTime();
  const lastX = sx(lastMs);
  const lastY = sy(lastP.users);

  // If the last point sits in the upper third of the chart, put the
  // annotation BELOW it so the label doesn't clip off the SVG.
  const annotateBelow = lastY < pad.top + innerH / 3;
  const annLineY = annotateBelow ? lastY + 30 : lastY - 30;
  const annText1Y = annotateBelow ? lastY + 22 : lastY - 32;
  const annText2Y = annotateBelow ? lastY + 36 : lastY - 18;

  // Info box (top-left, inside the plot)
  const infoX = pad.left + 14, infoY = pad.top + 14;
  const infoW = 320, infoH = 64;

  return (
    <div className="chart-scroll" style={{ overflowX: 'auto', maxWidth: '100%', WebkitOverflowScrolling: 'touch' }}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label="user growth chart"
         style={{ display: 'block', width: '100%', minWidth: 600, height: 'auto' }}>
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
      {/* "now" annotation — smart-placed above or below the last point */}
      <g>
        <line x1={lastX - 1} y1={lastY + (annotateBelow ? 1 : -1)} x2={lastX - 90} y2={annLineY}
              stroke="var(--accent-dim)" strokeWidth={0.8} />
        <circle cx={lastX} cy={lastY} r={3} fill="var(--accent)" />
        <text x={lastX - 94} y={annText1Y} fill="var(--fg)" fontSize={11.5}
              fontFamily="inherit" fontWeight={600} textAnchor="end">
          now: {lastP.users.toLocaleString()} users
        </text>
        <text x={lastX - 94} y={annText2Y} fill="var(--fg)" fontSize={11}
              fontFamily="inherit" textAnchor="end">
          {fmtUtcFull(lastMs)}
        </text>
      </g>

      {/* info box (top-left) */}
      {fit && (
        <g>
          <rect x={infoX} y={infoY} width={infoW} height={infoH}
                fill="rgba(0,0,0,0.55)" stroke="var(--accent-dim)" strokeWidth={1} rx={3} />
          <text x={infoX + 12} y={infoY + 18} fill="var(--accent)" fontSize={12} fontFamily="inherit">
            doubling time ≈ {fit.doublingHours != null ? `${fit.doublingHours.toFixed(2)} h` : '—'}
          </text>
          <text x={infoX + 12} y={infoY + 36} fill="var(--accent)" fontSize={12} fontFamily="inherit">
            fit slope b = {fit.b.toFixed(3)} /h
          </text>
          <text x={infoX + 12} y={infoY + 54} fill="var(--dim)" fontSize={10.5} fontFamily="inherit">
            (weighted, last {Math.round((Date.now() - fit.windowFromMs) / 3600000 * 10) / 10} h, R²={fit.r2.toFixed(3)})
          </text>
        </g>
      )}
    </svg>
    </div>
  );
}

export function LedgerPage() {
  const [d, setD] = useState<LedgerResponse | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  useEffect(() => { api.ledger().then(setD); }, []);

  const fit = useMemo(
    () => d ? expFit(d.user_growth, d.first_signup_at ? new Date(d.first_signup_at).getTime() : null, 2) : null,
    [d],
  );
  const milestones = useMemo(
    () => d ? computeMilestones(d.user_growth, d.first_signup_at) : [],
    [d],
  );

  if (!d) return <Panel title="PUBLIC LEDGER"><div>loading...</div></Panel>;

  // DOUBLING TIME now reflects the *current* rate (fit slope), not the
  // historical "from N/2 → N" measurement. Falls back to the historical
  // value when the fit can't be computed (very few users).
  const fitDoublingSec = fit?.doublingHours != null ? fit.doublingHours * 3600 : null;
  const doublingLine = fitDoublingSec !== null
    ? `  DOUBLING RATE      : ${formatDuration(Math.round(fitDoublingSec))} (current pace, b=${fit!.b.toFixed(3)}/h)`
    : d.doubling_seconds !== null
      ? `  DOUBLING RATE      : ${formatDuration(d.doubling_seconds)} (last ${Math.floor(d.user_count / 2)} → ${d.user_count}, no fit yet)`
      : '  DOUBLING RATE      : (need ≥ 2 users)';

  const lastAdjLine = d.last_adjustment_at
    ? `  LAST ADJUSTMENT     : ${fmtUtcStamp(d.last_adjustment_at)} (at ${(d.epoch * d.epoch_size).toLocaleString()} coins → +${d.epoch} bit${d.epoch === 1 ? '' : 's'})`
    : '  LAST ADJUSTMENT     : (none yet — at base difficulty)';

  const nextAdjLine = d.is_capped
    ? '  NEXT ADJUSTMENT     : (supply capped at 21,000,000)'
    : d.next_adjustment_eta_seconds === null
    ? `  NEXT ADJUSTMENT     : at ${d.next_milestone_at.toLocaleString()} coins (${d.coins_until_next_milestone.toLocaleString()} to go; rate too low to estimate)`
    : `  NEXT ADJUSTMENT     : ~${formatDuration(d.next_adjustment_eta_seconds)} (at ${d.next_milestone_at.toLocaleString()} coins, ${d.coins_until_next_milestone.toLocaleString()} to go @ ${d.mint_rate_per_minute}/min)`;

  return (
    <>
      <Panel title="PUBLIC LEDGER">
        <pre style={{ margin: 0 }}>
{`  TOTAL MINTED        : ${d.total_minted.toLocaleString()}
  TOTAL TRANSFERRED   : ${d.total_transferred.toLocaleString()}
  CIRCULATING SUPPLY  : ${d.circulating_supply.toLocaleString()}
  CURRENT DIFFICULTY  : ${d.current_difficulty_bits} trailing zero bits
                        (+1 bit per 1,000,000 minted; hard cap 21M)
${lastAdjLine}
${nextAdjLine}
  USER COUNT          : ${d.user_count.toLocaleString()}
`}
        </pre>
        <div style={{ marginTop: 12 }} className="tagline">
          a modern tribute to a tribute to the original rpow by hal finney —
          <a href="https://nakamotoinstitute.org/finney/rpow/" target="_blank" rel="noreferrer"> finney's announcement</a>
        </div>
      </Panel>

      <Panel title="USER GROWTH">
        {!chartOpen && (
          <button onClick={() => setChartOpen(true)}>
            [ + show user growth chart, fit, and milestones ]
          </button>
        )}
        {chartOpen && (
          <>
            <div style={{ marginBottom: 8 }}>
              <button onClick={() => setChartOpen(false)}>[ - hide ]</button>
            </div>
            <pre style={{ margin: '0 0 8px' }}>
{`  USERS              : ${d.user_count.toLocaleString()}
${doublingLine}`}
            </pre>
            <GrowthChart points={d.user_growth} firstSignupAt={d.first_signup_at} fit={fit} />
            <div style={{ marginTop: 16, marginBottom: 4 }} className="dim">
              MILESTONES
            </div>
            <MilestonesList rows={milestones} />
          </>
        )}
      </Panel>

      <Panel title="ABOUT RPOW">
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
{`  Hal Finney published RPOW (Reusable Proofs of Work) in 2004 as the
  first cryptographic money based on proof-of-work. Bitcoin came four
  years later, in 2008/2009.

  Finney was deeply involved in early Bitcoin: he received the first
  bitcoin transaction from Satoshi Nakamoto in January 2009. Many have
  speculated he was part of the team behind the Satoshi pseudonym — a
  claim he denied during his lifetime.

  The original RPOW was centralized. A single trusted server, running
  on an IBM 4758 secure coprocessor, signed token transfers and
  prevented double-spends. There was no blockchain, no decentralized
  consensus, and no difficulty adjustment — meaning the supply was
  effectively unbounded as long as someone had compute. (A trusted
  server could enforce a cap; Finney just didn't.)

  Bitcoin solved all three: decentralized consensus via PoW mining tied
  to a chain, automatic difficulty adjustment, and a fixed 21M supply
  cap.

  rpow3.com is a modern tribute to the spirit of Finney's original.
  No IBM 4758 — Ed25519 signatures, magic-link auth, Postgres ledger.
  Still centralized — but Bitcoin-flavored where it counts: a fixed
  21,000,000 supply cap, and a stepped difficulty adjustment that
  adds one trailing-zero bit for every 1,000,000 coins minted.
`}
        </pre>
      </Panel>
    </>
  );
}
