import { useEffect, useState } from 'react';
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

function GrowthChart({ points }: { points: UserGrowthPoint[] }) {
  if (points.length === 0) return <div className="dim">  (no signups yet)</div>;
  const W = 600, H = 200;
  const pad = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const xs = points.map(p => new Date(p.at).getTime());
  const ys = points.map(p => p.users);
  const x0 = xs[0]!, x1 = xs[xs.length - 1]!;
  const yMax = Math.max(1, ys[ys.length - 1]!);
  const xRange = Math.max(1, x1 - x0);

  const scaleX = (t: number) => pad.left + ((t - x0) / xRange) * innerW;
  const scaleY = (v: number) => pad.top + innerH - (v / yMax) * innerH;

  const path = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${scaleX(xs[i]!).toFixed(1)},${scaleY(p.users).toFixed(1)}`
  ).join(' ');

  const fmtDate = (t: number) => {
    const d = new Date(t);
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    return `${m}-${day} ${h}:00`;
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="user growth chart" style={{ display: 'block' }}>
      {/* axis baseline */}
      <line x1={pad.left} y1={pad.top + innerH} x2={pad.left + innerW} y2={pad.top + innerH}
            stroke="var(--dimmer)" strokeWidth={1} />
      <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + innerH}
            stroke="var(--dimmer)" strokeWidth={1} />
      {/* gridline at half */}
      <line x1={pad.left} y1={pad.top + innerH / 2} x2={pad.left + innerW} y2={pad.top + innerH / 2}
            stroke="var(--dimmer)" strokeWidth={1} strokeDasharray="2 4" opacity={0.5} />
      {/* curve */}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.5}
            strokeLinejoin="round" strokeLinecap="round" />
      {/* y-axis labels */}
      <text x={pad.left - 6} y={pad.top + 4} fill="var(--dim)" fontSize={11}
            fontFamily="inherit" textAnchor="end">{yMax}</text>
      <text x={pad.left - 6} y={pad.top + innerH / 2 + 4} fill="var(--dim)" fontSize={11}
            fontFamily="inherit" textAnchor="end">{Math.round(yMax / 2)}</text>
      <text x={pad.left - 6} y={pad.top + innerH + 4} fill="var(--dim)" fontSize={11}
            fontFamily="inherit" textAnchor="end">0</text>
      {/* x-axis labels (UTC) */}
      <text x={pad.left} y={H - 8} fill="var(--dim)" fontSize={11}
            fontFamily="inherit" textAnchor="start">{fmtDate(x0)}</text>
      <text x={pad.left + innerW} y={H - 8} fill="var(--dim)" fontSize={11}
            fontFamily="inherit" textAnchor="end">{fmtDate(x1)}</text>
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
${doublingLine}
  AXES               : x = UTC time   ·   y = cumulative users`}
        </pre>
        <GrowthChart points={d.user_growth} />
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
  Still centralized. Still no supply cap. Still no difficulty
  adjustment. Faithful by design.
`}
        </pre>
      </Panel>
    </>
  );
}
