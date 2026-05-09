// Lightning page — view balance, redeem to external, see payouts.
//
// The page is always available to logged-in users (so they can see their
// LN address and inbound balance even before redemption goes live), but
// the redemption form is disabled when the server reports enabled=false.

import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';
import type { LnBalanceResponse, LnPayout } from '@rpow/shared';

function fmtSat(msat: number): string {
  return Math.floor(msat / 1000).toLocaleString() + ' sats';
}

export function LightningPage() {
  const { me } = useMe();
  const [bal, setBal] = useState<LnBalanceResponse | null>(null);
  const [payouts, setPayouts] = useState<LnPayout[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    try {
      const [b, p] = await Promise.all([api.lnBalance(), api.lnPayouts().catch(() => [])]);
      setBal(b);
      setPayouts(p as LnPayout[]);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? 'failed');
    }
  }
  useEffect(() => { reload(); }, []);

  if (!me) return <Panel title="LIGHTNING"><div>not signed in.</div></Panel>;
  if (err && !bal) return <Panel title="LIGHTNING"><div className="error">{err}</div></Panel>;
  if (!bal) return <Panel title="LIGHTNING"><div>loading...</div></Panel>;

  return (
    <>
      <Panel title="LIGHTNING WALLET">
        <pre style={{ margin: 0 }}>
{`  LN ADDRESS  : ${bal.ln_address}
  BALANCE     : ${fmtSat(bal.balance_msat)} (${bal.balance_msat.toLocaleString()} msat)
  TOTAL IN    : ${fmtSat(bal.total_in_msat)}
  TOTAL OUT   : ${fmtSat(bal.total_out_msat)}
  24h PAYOUT  : ${fmtSat(bal.payouts_24h_msat)} / ${fmtSat(bal.max_payout_24h_msat)}
  STATUS      : ${bal.enabled ? 'ENABLED' : 'DISABLED (read-only — redemption coming soon)'}
`}
        </pre>
        <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
          Anyone can pay you sats by sending to <strong>{bal.ln_address}</strong> from a Lightning wallet.{' '}
          {!bal.ln_address_renamed && 'You can change the handle once.'}
        </div>
        <div style={{ marginTop: 8 }}>
          {!bal.ln_address_renamed && <RenameForm onRenamed={reload} />}
        </div>
      </Panel>

      <Panel title="REDEEM (CASH OUT)">
        {bal.enabled ? <RedeemForm onSubmitted={reload} /> : (
          <div className="dim">Redemption is currently disabled. Your inbound balance is safe — you'll be able to redeem once Lightning is enabled.</div>
        )}
      </Panel>

      <Panel title="PAYOUT HISTORY">
        {!payouts || payouts.length === 0 ? (
          <div className="dim">(no payouts yet)</div>
        ) : (
          <pre style={{ margin: 0, fontSize: 12, overflowX: 'auto' }}>
{payouts.map(p => {
  const when = new Date(p.created_at).toISOString().replace('T', ' ').slice(0, 19);
  return `  ${when}  ${p.state.padEnd(10)}  ${(p.amount_msat / 1000).toLocaleString().padStart(10)} sats  → ${p.destination}${p.failure_reason ? `  (${p.failure_reason})` : ''}`;
}).join('\n')}
          </pre>
        )}
      </Panel>
    </>
  );
}

function RenameForm({ onRenamed }: { onRenamed: () => void }) {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!handle) return;
    setBusy(true); setErr(null);
    try { await api.lnRename({ handle }); onRenamed(); }
    catch (e: any) { setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="dim" style={{ fontSize: 11 }}>rename handle:</span>
      <input value={handle} onChange={e => setHandle(e.target.value.toLowerCase())} placeholder="alice" pattern="[a-z0-9][a-z0-9_-]{2,31}" style={{ width: '20ch' }} />
      <button type="submit" disabled={busy}>{busy ? '[ ... ]' : '[ rename ]'}</button>
      {err && <span className="error">{err}</span>}
    </form>
  );
}

function RedeemForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [destination, setDestination] = useState('');
  const [sats, setSats] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await api.lnRedeem({ destination, amount_msat: sats * 1000 });
      setMsg(`payout #${r.payout_id} state=${r.state}`);
      onSubmitted();
    } catch (e: any) {
      setErr(`${e?.error ?? 'INTERNAL'}: ${e?.message ?? 'failed'}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <div>
        TO    : <input value={destination} onChange={e => setDestination(e.target.value)} placeholder="alice@strike.me or lnbc..." style={{ width: '40ch' }} />
      </div>
      <div className="dim" style={{ fontSize: 11 }}>Lightning address (foo@bar.com) or BOLT11 invoice.</div>
      <div style={{ marginTop: 6 }}>
        SATS  : <input type="number" min={1} value={sats} onChange={e => setSats(Number(e.target.value))} style={{ width: '10ch' }} />
      </div>
      <div className="dim" style={{ fontSize: 11 }}>1% rake + phoenixd routing fee deducted on top.</div>
      <div style={{ marginTop: 8 }}>
        <button type="submit" disabled={busy || !destination || sats <= 0}>{busy ? '[ ... ]' : '[ REDEEM ]'}</button>
      </div>
      {msg && <div className="accent" style={{ marginTop: 8 }}>{msg}</div>}
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
    </form>
  );
}
