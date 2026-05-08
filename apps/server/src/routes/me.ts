import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const email = s.email;
    const [{ rows: bal }, { rows: minted }, { rows: sent }, { rows: recv }, { rows: burned }] = await Promise.all([
      app.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email=$1 AND state='VALID'`, [email]),
      app.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL`, [email]),
      app.pool.query(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers WHERE sender_email=$1`, [email]),
      app.pool.query(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers WHERE recipient_email=$1`, [email]),
      app.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email=$1 AND state='BURNED'`, [email]),
    ]);
    return {
      email,
      balance: bal[0]!.n,
      minted: minted[0]!.n,
      sent: sent[0]!.n,
      received: recv[0]!.n,
      burned: burned[0]!.n,
    };
  });
}
