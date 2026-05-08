import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

interface MeBody {
  email: string;
  balance: number;
  minted: number;
  sent: number;
  received: number;
}

// Per-user cache for /me. Each /me hits 4 DB queries; under viral load
// (every wallet page load, every nav, every refresh-after-action) this
// becomes the dominant DB call volume. 2 s of staleness on the wallet
// view is invisible — your balance just blinks updated a beat later.
//
// We bound the cache at 50k entries and evict oldest on overflow so it
// can't grow unbounded as new users sign in. With ~50 bytes per entry
// that's well under 5 MB even fully populated.
const ME_CACHE_MS = 2_000;
const ME_CACHE_MAX = 50_000;
const meCache = new Map<string, { ts: number; body: MeBody }>();

function meCacheGet(email: string): MeBody | null {
  const hit = meCache.get(email);
  if (!hit) return null;
  if (Date.now() - hit.ts >= ME_CACHE_MS) {
    meCache.delete(email);
    return null;
  }
  return hit.body;
}

function meCacheSet(email: string, body: MeBody): void {
  if (meCache.size >= ME_CACHE_MAX) {
    // Map iteration is insertion-ordered, so the first key is the oldest.
    const oldest = meCache.keys().next().value;
    if (oldest !== undefined) meCache.delete(oldest);
  }
  meCache.set(email, { ts: Date.now(), body });
}

/** Invalidate a user's cached /me row after any mutation that changes their balance. */
export function invalidateMe(email: string): void {
  meCache.delete(email);
}

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const email = s.email;
    const cached = meCacheGet(email);
    if (cached) return cached;

    const [{ rows: bal }, { rows: minted }, { rows: sent }, { rows: recv }] = await Promise.all([
      app.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email=$1 AND state='VALID'`, [email]),
      app.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL`, [email]),
      app.pool.query(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers WHERE sender_email=$1`, [email]),
      app.pool.query(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers WHERE recipient_email=$1`, [email]),
    ]);
    const body: MeBody = {
      email,
      balance: bal[0]!.n,
      minted: minted[0]!.n,
      sent: sent[0]!.n,
      received: recv[0]!.n,
    };
    meCacheSet(email, body);
    return body;
  });
}
