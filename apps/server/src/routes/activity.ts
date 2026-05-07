import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

export async function activityRoutes(app: FastifyInstance) {
  app.get('/activity', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const sql = `
      SELECT 'mint' AS type, value AS amount, NULL::text AS counterparty_email, issued_at AS at
      FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL
      UNION ALL
      SELECT 'send' AS type, amount, recipient_email AS counterparty_email, created_at AS at
      FROM transfers WHERE sender_email=$1
      UNION ALL
      SELECT 'receive' AS type, amount, sender_email AS counterparty_email, created_at AS at
      FROM transfers WHERE recipient_email=$1
      ORDER BY at DESC LIMIT 100`;
    const { rows } = await app.pool.query(sql, [s.email]);
    return rows.map(r => ({ ...r, at: r.at.toISOString() }));
  });
}
