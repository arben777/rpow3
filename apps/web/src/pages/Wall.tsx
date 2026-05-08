import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import { useMe } from '../hooks/useMe.js';
import type { PostSummary } from '@rpow/shared';

export function WallPage() {
  const { me } = useMe();
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.posts().then(setPosts).catch(e => setError(e?.message ?? 'failed'));
  }, []);

  return (
    <>
      <Panel title="THE WALL — PUBLIC">
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
{`  spend one RPOW to post. tokens are burned, never recovered.
  hashcash, finally reused. messages and authors are public forever.
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
      <Panel>
        {error && <div className="error">{error}</div>}
        {!error && posts === null && <div>loading...</div>}
        {posts && posts.length === 0 && <div>(no posts yet — be the first to burn a token)</div>}
        {posts && posts.length > 0 && posts.map(p => (
          <article key={p.id} style={{ marginBottom: 18 }}>
            <pre style={{ margin: 0, opacity: 0.7 }}>
{`  ${p.created_at.replace('T', ' ').slice(0, 19)}  ${p.author_email}  -1 RPOW`}
            </pre>
            <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
{`  ${p.body.split('\n').join('\n  ')}`}
            </pre>
            <pre style={{ margin: '4px 0 0', opacity: 0.5, fontSize: 12 }}>
{`  burned token: ${p.token_id.slice(0, 8)}...${p.token_id.slice(-4)}`}
            </pre>
          </article>
        ))}
      </Panel>
    </>
  );
}
