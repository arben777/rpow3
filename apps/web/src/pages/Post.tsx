import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import { useMe } from '../hooks/useMe.js';

const MAX = 280;

export function PostPage() {
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'idle' | 'posting' | 'error'>('idle');
  const [error, setError] = useState('');

  if (!me) return (
    <Panel title="POST TO WALL">
      <div>not signed in.</div>
      <div style={{ marginTop: 8 }}><Link to="/login">[ go to login ]</Link></div>
    </Panel>
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status === 'posting') return;
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    setStatus('posting'); setError('');
    try {
      await api.post({ body: trimmed, idempotency_key: crypto.randomUUID() });
      await refresh();
      navigate('/wall');
    } catch (err: any) {
      setStatus('error');
      const code = err?.error ?? 'INTERNAL';
      const msgs: Record<string, string> = {
        INSUFFICIENT_BALANCE: 'no tokens to burn — go mine one first',
        BAD_REQUEST: err?.message ?? 'bad request',
        UNAUTHORIZED: 'session expired — please log in again',
      };
      setError(msgs[code] ?? code);
    }
  }

  const remaining = MAX - body.length;
  const canPost = body.trim().length > 0 && remaining >= 0 && me.balance > 0 && status !== 'posting';

  return (
    <Panel title="POST TO WALL">
      <pre style={{ margin: 0 }}>
{`  > AUTHOR    : ${me.email}
  > COST      : 1 RPOW (your token will be burned)
  > BALANCE   : ${String(me.balance).padStart(4, '0')} RPOW
`}
      </pre>
      <form onSubmit={submit}>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value.slice(0, MAX))}
          rows={6}
          maxLength={MAX}
          placeholder="say something on the wall..."
          style={{ width: '100%', fontFamily: 'inherit', fontSize: 'inherit', boxSizing: 'border-box', marginTop: 4 }}
        />
        <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            your email will appear publicly next to this post — forever.
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{remaining}/{MAX}</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={!canPost}>
            [ {status === 'posting' ? '...' : 'POST · BURN 1 RPOW'} ]
          </button>{' '}
          <Link to="/wall">[ cancel ]</Link>
        </div>
      </form>
      {status === 'error' && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
      {me.balance === 0 && (
        <div style={{ marginTop: 8 }}>
          you have no tokens to burn. <Link to="/mine">[ mine one ]</Link>
        </div>
      )}
    </Panel>
  );
}
