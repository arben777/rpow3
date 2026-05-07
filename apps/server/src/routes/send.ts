import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';

const Body = z.object({
  recipient_email: z.string().email(),
  amount: z.number().int().positive().max(1_000_000),
  idempotency_key: z.string().min(8).max(80),
});

const PENDING_TTL_DAYS = 30;

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

    type SendResult =
      | { ok: true; transferred: number; recipient_email: string; transfer_id: string; pending?: boolean }
      | { error: 'BAD_REQUEST' | 'INSUFFICIENT_BALANCE'; message: string; status: number };

    let out!: SendResult;
    try {
      out = await withTx<SendResult>(app.pool, async (c) => {
        // Idempotency: check both transfers and pending_transfers tables.
        const txDup = await c.query<{ id: string; recipient_email: string; amount: number }>(
          'SELECT id, recipient_email, amount FROM transfers WHERE idempotency_key=$1', [idem],
        );
        if (txDup.rows[0]) {
          if (txDup.rows[0].recipient_email !== recipient || txDup.rows[0].amount !== amount) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return { ok: true as const, transferred: txDup.rows[0].amount, recipient_email: txDup.rows[0].recipient_email, transfer_id: txDup.rows[0].id };
        }
        const ptDup = await c.query<{ id: string; recipient_email: string; amount: number }>(
          'SELECT id, recipient_email, amount FROM pending_transfers WHERE idempotency_key=$1', [idem],
        );
        if (ptDup.rows[0]) {
          if (ptDup.rows[0].recipient_email !== recipient || ptDup.rows[0].amount !== amount) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return { ok: true as const, pending: true, transferred: ptDup.rows[0].amount, recipient_email: ptDup.rows[0].recipient_email, transfer_id: ptDup.rows[0].id };
        }

        // Lock and check balance (same for both paths).
        const lockSql = `SELECT id FROM tokens
          WHERE owner_email=$1 AND state='VALID'
          ORDER BY issued_at ASC
          LIMIT $2 FOR UPDATE SKIP LOCKED`;
        const { rows: locked } = await c.query<{ id: string }>(lockSql, [sender, amount]);
        if (locked.length < amount) return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };

        const recipientExists = await c.query('SELECT 1 FROM users WHERE email=$1', [recipient]);

        if (recipientExists.rowCount) {
          // Existing recipient: invalidate sender tokens, mint fresh tokens for recipient.
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
        }

        // Recipient does not exist: invalidate sender tokens and create a pending claim.
        for (const t of locked) {
          await c.query(`UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1`, [t.id]);
        }

        const claimToken = randomBytes(32).toString('base64url');
        const claimTokenHash = createHash('sha256').update(claimToken).digest();
        const pendingId = randomUUID();
        const expiresAt = new Date(Date.now() + PENDING_TTL_DAYS * 24 * 60 * 60 * 1000);

        await c.query(
          `INSERT INTO pending_transfers
           (id, sender_email, recipient_email, amount, idempotency_key, claim_token_hash, expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [pendingId, sender, recipient, amount, idem, claimTokenHash, expiresAt],
        );

        // Email send is inside the transaction so a failure rolls back the invalidation.
        const claimUrl = `${app.config.magicLinkBaseUrl}/claim?token=${claimToken}`;
        const subject = `${sender} sent you ${amount} RPOW`;
        const text = `${sender} sent you ${amount} RPOW (Reusable Proofs of Work) on rpow2.com.\n\nClick to claim:\n${claimUrl}\n\nLink expires in ${PENDING_TTL_DAYS} days.\n\n--\nrpow2.com — a modern tribute to a tribute to the original rpow by hal finney`;
        const html = `<div style="font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;background:#0b0b0b;color:#e8e3d3;padding:24px;max-width:560px;margin:0 auto;">
  <p style="margin:0 0 16px 0;font-size:14px;"><strong style="color:#6ee7b7;">${sender}</strong> just sent you <strong style="color:#6ee7b7;">${amount} RPOW</strong> (Reusable Proofs of Work) on <a href="https://rpow2.com" style="color:#6ee7b7;">rpow2.com</a>.</p>
  <p style="margin:0 0 24px 0;"><a href="${claimUrl}" style="background:#6ee7b7;color:#0b0b0b;padding:10px 18px;text-decoration:none;border-radius:4px;font-weight:bold;display:inline-block;">[ CLAIM ${amount} RPOW ]</a></p>
  <p style="font-size:12px;color:#888;margin:0 0 8px 0;">Or paste this link in your browser:</p>
  <p style="font-size:11px;color:#aaa;margin:0 0 24px 0;word-break:break-all;"><a href="${claimUrl}" style="color:#aaa;">${claimUrl}</a></p>
  <hr style="border:none;border-top:1px solid #333;margin:24px 0;">
  <p style="font-size:11px;color:#666;margin:0;">Link expires in ${PENDING_TTL_DAYS} days. rpow2.com — a modern tribute to a tribute to the original rpow by hal finney.</p>
</div>`;

        await app.mailer.send({ to: recipient, subject, text, html });

        return { ok: true as const, transferred: amount, recipient_email: recipient, transfer_id: pendingId, pending: true };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        const tx = await app.pool.query<{ id: string; recipient_email: string; amount: number }>(
          'SELECT id, recipient_email, amount FROM transfers WHERE idempotency_key=$1', [idem],
        );
        if (tx.rows[0]) {
          return reply.send({ ok: true, transferred: tx.rows[0].amount, recipient_email: tx.rows[0].recipient_email, transfer_id: tx.rows[0].id });
        }
        const pt = await app.pool.query<{ id: string; recipient_email: string; amount: number }>(
          'SELECT id, recipient_email, amount FROM pending_transfers WHERE idempotency_key=$1', [idem],
        );
        if (pt.rows[0]) {
          return reply.send({ ok: true, pending: true, transferred: pt.rows[0].amount, recipient_email: pt.rows[0].recipient_email, transfer_id: pt.rows[0].id });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });
}
