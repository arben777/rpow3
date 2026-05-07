import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';

const Body = z.object({
  recipient_email: z.string().email(),
  amount: z.number().int().positive().max(1_000_000),
  idempotency_key: z.string().min(8).max(80),
});

export async function sendRoutes(app: FastifyInstance) {
  app.post('/send', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const sender = s.email;
    const recipient = parsed.data.recipient_email.toLowerCase().trim();
    const amount = parsed.data.amount;
    const idem = parsed.data.idempotency_key;

    if (recipient === sender) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'cannot send to self' });

    const out = await withTx(app.pool, async (c) => {
      const existing = await c.query<{ id: string; recipient_email: string; amount: number }>(
        'SELECT id, recipient_email, amount FROM transfers WHERE idempotency_key=$1', [idem],
      );
      if (existing.rows[0]) {
        return { ok: true as const, transferred: existing.rows[0].amount, recipient_email: existing.rows[0].recipient_email, transfer_id: existing.rows[0].id };
      }

      const exists = await c.query('SELECT 1 FROM users WHERE email=$1', [recipient]);
      if (!exists.rowCount) return { error: 'RECIPIENT_NOT_FOUND' as const, message: 'recipient has no rpow2 account', status: 404 };

      const lockSql = `SELECT id FROM tokens
        WHERE owner_email=$1 AND state='VALID'
        ORDER BY issued_at ASC
        LIMIT $2 FOR UPDATE SKIP LOCKED`;
      const { rows: locked } = await c.query<{ id: string }>(lockSql, [sender, amount]);
      if (locked.length < amount) return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };

      const transferId = randomUUID();
      const ownerHash = createHash('sha256').update(recipient).digest('hex');
      const issuedAt = new Date();

      for (const t of locked) {
        const newId = randomUUID();
        const sig = signTokenPayload(
          { id: newId, owner_email_hash: ownerHash, value: 1, issued_at: issuedAt.toISOString() },
          app.config.signingPrivateKeyHex,
        );
        await c.query(`UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1`, [t.id]);
        await c.query(
          `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
           VALUES($1, $2, 1, 'VALID', $3, $4, $5)`,
          [newId, recipient, issuedAt, t.id, sig],
        );
      }

      await c.query(
        'INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key) VALUES($1,$2,$3,$4,$5)',
        [transferId, sender, recipient, amount, idem],
      );
      return { ok: true as const, transferred: amount, recipient_email: recipient, transfer_id: transferId };
    });

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });
}
