// Public list of canvas timestamps (the OpenTimestamps "anchor to Bitcoin"
// feature). Each row shows the snapshot date, SHA-256 of the canonical
// state, and a download link to the .ots proof file. Once the OTS
// calendar upgrades the proof to include a Bitcoin block path (~1-6
// hours after submission), the bitcoin_block_height column lights up.

import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { CanvasTimestamp } from '@rpow/shared';

function shortHex(hex: string): string {
  return hex.slice(0, 12) + '…' + hex.slice(-8);
}
function fmtUtc(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

const BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080') as string;

export function TimestampsPage() {
  const [rows, setRows] = useState<CanvasTimestamp[] | null>(null);
  const [hash, setHash] = useState<{ state_sha256_hex: string; slot_count: number; total_rpow_burned: number; generated_at: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.billboardTimestamps(), api.billboardStateHash()])
      .then(([ts, h]) => { setRows(ts); setHash(h); })
      .catch(e => setErr(e?.message ?? 'failed'));
  }, []);

  return (
    <>
      <Panel title="BILLBOARD ↔ BITCOIN: CURRENT STATE">
        {hash && (
          <pre style={{ margin: 0 }}>
{`  current state hash : ${hash.state_sha256_hex}
  slot count         : ${hash.slot_count.toLocaleString()}
  total rpow burned  : ${hash.total_rpow_burned.toLocaleString()}
  generated at       : ${fmtUtc(hash.generated_at)}
`}
          </pre>
        )}
        <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
          Every UTC midnight, the server SHA-256s the canonical billboard state and submits the
          digest to the public OpenTimestamps calendar pool. Within a few hours, the resulting
          .ots proof embeds a path into a Bitcoin block header — at which point the snapshot
          can be independently verified against any Bitcoin full node, forever, with no trust
          required in this server.
          {' '}
          <a href="https://opentimestamps.org" target="_blank" rel="noreferrer">opentimestamps.org</a>
          {' · '}
          <a href="https://github.com/opentimestamps/opentimestamps-client" target="_blank" rel="noreferrer">ots CLI</a>
        </div>
      </Panel>

      <Panel title="DAILY ANCHORS">
        {err && !rows ? <div className="error">{err}</div> :
         !rows ? <div>loading...</div> :
         rows.length === 0 ? <div className="dim">(no daily snapshots yet — first one fires at next 00:05 UTC)</div> : (
          <pre style={{ margin: 0, fontSize: 12, overflowX: 'auto' }}>
{[
  '  date                  state_sha256                                                       slots    rpow      bitcoin block            proof',
  '  --------------------  -----------------------------------------------------------------  -------  --------  -----------------------  ----------'
].concat(rows.map(r => {
  const date = fmtUtc(r.snapshot_at).slice(0, 19);
  const block = r.bitcoin_block_height
    ? `${r.bitcoin_block_height.toLocaleString().padEnd(8)} ${r.bitcoin_block_hash_hex ? shortHex(r.bitcoin_block_hash_hex) : ''}`
    : `(${r.status})`;
  const link = r.ots_proof_url ? `${BASE}${r.ots_proof_url}` : '';
  return `  ${date}  ${shortHex(r.state_sha256_hex).padEnd(64)}  ${String(r.slot_count).padStart(7)}  ${String(r.total_rpow_burned).padStart(8)}  ${block.padEnd(23)}  ${link ? `[.ots] ${link}` : ''}`;
})).join('\n')}
          </pre>
        )}
      </Panel>

      <Panel title="VERIFY YOURSELF">
        <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
{`  pip install opentimestamps-client
  curl -O ${BASE}/billboard/timestamps/<id>.ots
  ots upgrade rpow3-billboard-YYYY-MM-DD.ots
  ots verify rpow3-billboard-YYYY-MM-DD.ots

  Verification will print the Bitcoin block height that the snapshot's
  state_sha256 was committed to. No trust in rpow3.com required.
`}
        </pre>
      </Panel>
    </>
  );
}
