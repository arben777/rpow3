import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import { useMe } from '../hooks/useMe.js';
import type { PostSummary } from '@rpow/shared';

export function WallPage() {
  const { me, refresh } = useMe();
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [boostAmounts, setBoostAmounts] = useState<Record<string, number>>({});

  async function load() {
    try { setPosts(await api.posts()); } catch (e: any) { setError(e?.message ?? 'failed'); }
  }
  useEffect(() => { load(); }, []);

  async function boost(p: PostSummary) {
    if (!me) return;
    const amount = Math.max(1, Math.floor(boostAmounts[p.id] ?? 1));
    if (amount < 1 || amount > me.balance) return;
    setBusyId(p.id); setActionError('');
    try {
      await api.boost(p.id, { amount, idempotency_key: crypto.randomUUID() });
      await Promise.all([refresh(), load()]);
    } catch (err: any) {
      setActionError(err?.message ?? err?.error ?? 'boost failed');
    } finally { setBusyId(null); }
  }

  async function graveyard(p: PostSummary) {
    if (!me) return;
    const cost = p.stake * 2;
    if (cost > me.balance) {
      setActionError(`need ${cost} RPOW to graveyard this post (you have ${me.balance})`);
      return;
    }
    if (!confirm(`burn ${cost} RPOW to delete this post forever? this cannot be undone.`)) return;
    setBusyId(p.id); setActionError('');
    try {
      await api.graveyard(p.id, { idempotency_key: crypto.randomUUID() });
      await Promise.all([refresh(), load()]);
    } catch (err: any) {
      setActionError(err?.message ?? err?.error ?? 'graveyard failed');
    } finally { setBusyId(null); }
  }

  return (
    <>
      <Panel title="THE WALL — PUBLIC">
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
{`  burn 1 RPOW to post. boost any post by burning more RPOW —
  most-burned rises to the top. burn 2× a post's stake to send
  it to the graveyard, deleting it forever. every action burns
  tokens. hashcash, finally reused.
`}
        </pre>
        <div style={{ marginTop: 8 }}>
          {me ? (
            <Link to="/post">[ + POST · BURN 1 RPOW ]</Link>
          ) : (
            <Link to="/login">[ login to post ]</Link>
          )}
        </div>
      </Panel>

      {actionError && <Panel><div className="error">{actionError}</div></Panel>}

      <Panel>
        {error && <div className="error">{error}</div>}
        {!error && posts === null && <div>loading...</div>}
        {posts && posts.length === 0 && <div>(no posts yet — be the first to burn a token)</div>}
        {posts && posts.length > 0 && posts.map(p => {
          const cost = p.stake * 2;
          const isBusy = busyId === p.id;
          const canBoost = !!me && me.balance >= 1 && !isBusy;
          const canGraveyard = !!me && me.balance >= cost && !isBusy;
          const amt = Math.max(1, Math.floor(boostAmounts[p.id] ?? 1));
          return (
            <article key={p.id} style={{ marginBottom: 20 }}>
              <pre style={{ margin: 0, opacity: 0.75 }}>
{`  ${p.created_at.replace('T', ' ').slice(0, 19)}  ${p.author_email}  stake: ${p.stake} RPOW`}
              </pre>
              <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
{`  ${(p.body ?? '').split('\n').join('\n  ')}`}
              </pre>
              <pre style={{ margin: '4px 0 0', opacity: 0.5, fontSize: 12 }}>
{`  burned token: ${p.token_id.slice(0, 8)}...${p.token_id.slice(-4)}`}
              </pre>
              {me && (
                <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="number" min={1} max={me.balance || 1} value={amt}
                    onChange={e => setBoostAmounts({ ...boostAmounts, [p.id]: Math.max(1, Number(e.target.value) || 1) })}
                    style={{ width: '8ch', fontFamily: 'inherit', fontSize: 'inherit' }}
                    disabled={isBusy}
                  />
                  <button onClick={() => boost(p)} disabled={!canBoost}>
                    [ {isBusy ? '...' : `BOOST · BURN ${amt} RPOW`} ]
                  </button>
                  <button onClick={() => graveyard(p)} disabled={!canGraveyard} title={`burns ${cost} RPOW (2× stake)`}>
                    [ GRAVEYARD · BURN {cost} RPOW ]
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </Panel>
    </>
  );
}
