import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { StatsResponse } from '@rpow/shared';

function fmt(n: number): string { return n.toLocaleString(); }
function pct(n: number, digits = 1): string { return `${n.toFixed(digits)}%`; }
function fmtRequests(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function Bar({ percent, width = 32 }: { percent: number; width?: number }) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return (
    <span style={{ fontFamily: 'inherit' }}>
      <span style={{ color: 'var(--accent)' }}>{'█'.repeat(filled)}</span>
      <span className="dim">{'░'.repeat(width - filled)}</span>
    </span>
  );
}

function StatTile({
  label, value, sub, accent,
}: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{
      border: '1px solid var(--accent-dim)',
      padding: '10px 14px',
      borderRadius: 3,
      background: 'rgba(255,255,255,0.01)',
      minWidth: 0,
    }}>
      <div className="dim" style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 600,
        color: accent ? 'var(--accent)' : 'var(--fg)',
        marginTop: 2, wordBreak: 'break-all',
      }}>
        {value}
      </div>
      {sub && <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function TileGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: 8,
    }}>
      {children}
    </div>
  );
}

interface BarRowProps {
  label: string;
  count: string;
  percent: number;
  barWidth?: number;
}
function BarRow({ label, count, percent, barWidth = 28 }: BarRowProps) {
  // monospace-friendly row: fixed-width label, fixed-width count, then bar
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(7em, max-content) minmax(4em, max-content) 1fr',
      gap: 12,
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
      padding: '1px 0',
    }}>
      <span>{label}</span>
      <span style={{ textAlign: 'right' }}>{count}</span>
      <span><Bar percent={percent} width={barWidth} /></span>
    </div>
  );
}

interface TableProps<T> {
  columns: { header: string; align?: 'left' | 'right'; cell: (row: T) => React.ReactNode; width?: string }[];
  rows: T[];
}
function Table<T>({ columns, rows }: TableProps<T>) {
  const gridTemplate = columns.map(c => c.width ?? 'minmax(0, 1fr)').join(' ');
  return (
    <div style={{ fontFamily: 'inherit', overflowX: 'auto' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: gridTemplate, gap: 8,
        color: 'var(--dim)', fontSize: 11, letterSpacing: '0.08em',
        textTransform: 'uppercase', borderBottom: '1px solid var(--accent-dim)',
        paddingBottom: 4, marginBottom: 4,
      }}>
        {columns.map((c, i) => (
          <div key={i} style={{ textAlign: c.align ?? 'left' }}>{c.header}</div>
        ))}
      </div>
      {rows.map((row, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: gridTemplate, gap: 8,
          padding: '3px 0',
        }}>
          {columns.map((c, j) => (
            <div key={j} style={{ textAlign: c.align ?? 'left' }}>{c.cell(row)}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function StatsPage({ embedded = false }: { embedded?: boolean }) {
  const [d, setD] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load() {
      try {
        const body = await api.stats();
        if (!alive) return;
        setD(body);
        setErr(null);
        // Re-poll on the server's cache cadence, clamped to [15s, 2min].
        const ms = Math.min(120_000, Math.max(15_000, (body.auto_update_seconds || 60) * 1000));
        timer = setTimeout(load, ms);
      } catch (e: unknown) {
        if (!alive) return;
        const msg = e && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : 'failed to load';
        setErr(msg);
        timer = setTimeout(load, 30_000);
      }
    }
    void load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  if (err && !d) return <Panel title="LIVE NETWORK STATS"><div className="error">error: {err}</div></Panel>;
  if (!d) return <Panel title="LIVE NETWORK STATS"><div>loading...</div></Panel>;

  const generated = new Date(d.generated_at);
  const generatedStr = `${String(generated.getUTCHours()).padStart(2, '0')}:${String(generated.getUTCMinutes()).padStart(2, '0')} UTC`;
  const providerMax = Math.max(1, ...d.email_providers.map(p => p.count));

  return (
    <>
      <Panel title="LIVE NETWORK STATS">
        <div style={{ marginBottom: 12 }}>
          <div className="accent" style={{ fontSize: 14, fontWeight: 600 }}>RPOW3</div>
          <div className="dim" style={{ marginTop: 2 }}>
            Proof-of-work token network. {fmt(d.live.max_supply)} fixed supply.
          </div>
          <div className="accent" style={{ fontSize: 11, marginTop: 6, letterSpacing: '0.08em' }}>
            ● auto-updating every {Math.max(1, Math.round(d.auto_update_seconds / 60))} min · snapshot {generatedStr}
          </div>
        </div>

        <TileGrid>
          <StatTile label="Miners" value={fmt(d.live.miners)} sub="registered accounts" accent />
          <StatTile label="Circulating" value={fmt(d.live.circulating)} sub="valid tokens" accent />
          <StatTile label="Transferred" value={fmt(d.live.transferred)} sub="tokens moved between users" accent />
          <StatTile label="Minted" value={fmt(d.live.minted)} sub={`${pct(d.live.percent_minted)} of max supply`} accent />
        </TileGrid>
      </Panel>

      <Panel title="TOKEN SUPPLY PROGRESS">
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
          <div style={{ fontFamily: 'inherit' }}>
            <span className="accent" style={{ fontSize: 18, fontWeight: 600 }}>{pct(d.live.percent_minted)}</span>{' '}
            <span className="dim">minted</span>
          </div>
          <Bar percent={d.live.percent_minted} width={48} />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 8, marginTop: 6,
          }}>
            <StatTile label="Minted" value={fmt(d.live.minted)} accent />
            <StatTile label="Max supply" value={fmt(d.live.max_supply)} />
            <StatTile label="Remaining" value={fmt(d.live.remaining)} />
          </div>
        </div>
      </Panel>

      <Panel title="MINING DIFFICULTY">
        <TileGrid>
          <StatTile label="Current bits" value={String(d.difficulty.current_bits)} accent />
          <StatTile label="Next bits" value={String(d.difficulty.next_bits)} />
          <StatTile label="Epoch" value={String(d.difficulty.epoch)} />
        </TileGrid>
        <div style={{
          marginTop: 14, padding: 10,
          border: '1px solid var(--accent-dim)', borderRadius: 3,
          background: 'rgba(255,255,255,0.01)',
        }}>
          <div className="dim" style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Next difficulty increase
          </div>
          <div style={{ marginTop: 4 }}>
            {fmt(d.difficulty.in_epoch)} / {fmt(d.difficulty.epoch_size)} tokens this epoch
            {' · '}
            <span className="dim">{fmt(d.difficulty.coins_to_next)} to go</span>
          </div>
          <div style={{ marginTop: 4 }}>
            <Bar percent={d.difficulty.epoch_progress_percent} width={42} />{' '}
            <span className="accent">{pct(d.difficulty.epoch_progress_percent)}</span>
          </div>
          {d.difficulty.is_capped && (
            <div className="dim" style={{ marginTop: 6 }}>
              (supply capped at {fmt(d.live.max_supply)} — no further difficulty increases)
            </div>
          )}
        </div>
      </Panel>

      <Panel title="TOP MINERS">
        {d.top_miners.length === 0 ? (
          <div className="dim">(no miners yet)</div>
        ) : (
          <Table
            columns={[
              { header: '#', width: '2em', cell: (m) => m.rank },
              { header: 'Miner', width: 'minmax(0, 2fr)', cell: (m) => m.email_masked },
              { header: 'Tokens', align: 'right', width: 'minmax(0, 1fr)', cell: (m) => fmt(m.tokens) },
              { header: '%', align: 'right', width: '4em', cell: (m) => pct(m.percent) },
            ]}
            rows={d.top_miners}
          />
        )}
      </Panel>

      <Panel title="SUPPLY CONCENTRATION">
        <BarRow label="Top 10" count={pct(d.concentration.top10_percent)} percent={d.concentration.top10_percent} />
        <BarRow label="Top 30" count={pct(d.concentration.top30_percent)} percent={d.concentration.top30_percent} />
        <BarRow label="Others" count={pct(d.concentration.others_percent)} percent={d.concentration.others_percent} />
        <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
          Top 10 hold {fmt(d.concentration.top10_tokens)} tokens ({pct(d.concentration.top10_percent)}).{' '}
          {fmt(d.concentration.others_user_count)} miners share {pct(d.concentration.others_percent)}.
        </div>
      </Panel>

      <Panel title="EMAIL PROVIDER DISTRIBUTION">
        {d.email_providers.map((p, i) => (
          <BarRow
            key={i}
            label={p.name}
            count={fmt(p.count)}
            percent={(p.count / providerMax) * 100}
          />
        ))}
      </Panel>

      <Panel title="MINERS BY REGION">
        {d.regions.map((r, i) => (
          <BarRow
            key={i}
            label={r.name}
            count={`${fmt(r.count)} (${pct(r.percent)})`}
            percent={r.percent}
          />
        ))}
        <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
          Region inferred from email domain. True geographic data requires IP geolocation.
        </div>
      </Panel>

      <Panel title="MINING CLIENTS">
        {d.clients.length === 0 ? (
          <div className="dim">(no traffic yet — counters populate after the first request flush)</div>
        ) : (
          <>
            {d.clients.slice(0, 12).map((c, i) => (
              <BarRow
                key={i}
                label={c.name}
                count={fmtRequests(c.requests)}
                percent={(c.requests / Math.max(1, d.clients[0]!.requests)) * 100}
              />
            ))}
            <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
              {d.clients.length} distinct client{d.clients.length === 1 ? '' : 's'} observed.
              Counters refresh every {Math.max(1, Math.round(d.auto_update_seconds / 60))} min.
            </div>
          </>
        )}
      </Panel>

      <Panel title="TOP TRAFFIC SOURCES">
        {d.traffic_sources.length === 0 ? (
          <div className="dim">(no traffic yet)</div>
        ) : (
          <>
            <Table
              columns={[
                { header: '#', width: '2em', cell: (s) => s.rank },
                { header: 'Source', width: 'minmax(0, 2fr)', cell: (s) => s.source_masked },
                { header: 'Client', width: 'minmax(0, 1fr)', cell: (s) => s.client ?? '?' },
                { header: 'Requests', align: 'right', width: 'minmax(0, 1fr)', cell: (s) => fmtRequests(s.requests) },
              ]}
              rows={d.traffic_sources}
            />
            <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
              Top 10 sources account for {pct(d.traffic_top10_share_percent)} of {fmtRequests(d.traffic_total_requests)} total requests.
            </div>
          </>
        )}
      </Panel>

      <Panel title="API ENDPOINT TRAFFIC">
        {d.endpoint_traffic.length === 0 ? (
          <div className="dim">(no traffic yet)</div>
        ) : (
          <>
            {d.endpoint_traffic.slice(0, 10).map((e, i) => (
              <BarRow
                key={i}
                label={e.endpoint}
                count={fmtRequests(e.requests)}
                percent={(e.requests / Math.max(1, d.endpoint_traffic[0]!.requests)) * 100}
              />
            ))}
            <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
              Mining endpoints (/challenge + /mint) = <span className="accent">{pct(d.mining_request_share_percent)}</span> of {fmtRequests(d.traffic_total_requests)} total requests.
            </div>
          </>
        )}
      </Panel>

      {embedded && (
        <div style={{ marginTop: 18, textAlign: 'center' }}>
          <a href="https://rpow3.com">[ rpow3.com — start mining ]</a>
        </div>
      )}
    </>
  );
}
