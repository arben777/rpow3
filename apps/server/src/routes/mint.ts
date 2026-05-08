import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { verifySolution } from '../pow.js';
import { signTokenPayload } from '../signing.js';
import { withTx } from '../db.js';

const Body = z.object({ challenge_id: z.string().uuid(), solution_nonce: z.string().regex(/^\d{1,20}$/) });

export async function mintRoutes(app: FastifyInstance) {
  app.post('/mint', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const result = await withTx(app.pool, async (c) => {
      // No advisory lock here. The cap-check uses an atomic UPDATE on
      // app_counters with a `value < $cap` predicate (below), which is
      // race-free on its own — Postgres's row-level lock during UPDATE
      // serializes only the cap-counter row, not all mints globally.
      // The previous advisory_xact_lock made every mint wait behind a
      // single global mutex, which under viral load (~250 mints/sec
      // attempted) became the dominant bottleneck and made any orphan
      // transaction (e.g. an EOF mid-mint) cascade into a pile-up of
      // waiting mints. Removing it lets concurrent users mint in
      // parallel; the only contention is the brief row lock during the
      // counter UPDATE.

      const { rows } = await c.query<{ id: string; nonce_prefix: Buffer; difficulty_bits: number; expires_at: Date; claimed_at: Date | null }>(
        'SELECT id, nonce_prefix, difficulty_bits, expires_at, claimed_at FROM challenges WHERE id=$1 AND user_email=$2 FOR UPDATE',
        [parsed.data.challenge_id, s.email],
      );
      const ch = rows[0];
      if (!ch) return { error: 'BAD_REQUEST' as const, message: 'unknown challenge' };
      if (ch.claimed_at) return { error: 'CHALLENGE_ALREADY_CLAIMED' as const, message: 'already claimed' };
      if (ch.expires_at.getTime() < Date.now()) return { error: 'CHALLENGE_EXPIRED' as const, message: 'expired' };

      const nonce = BigInt(parsed.data.solution_nonce);
      if (!verifySolution(ch.nonce_prefix, nonce, ch.difficulty_bits)) {
        return { error: 'INVALID_SOLUTION' as const, message: 'hash does not meet difficulty' };
      }

      // Atomic cap-check + increment via maintained counter (migration 005).
      // count(*) on a growing tokens table was the lock-hold bottleneck.
      const supplyResult = await c.query(
        `UPDATE app_counters SET value = value + 1
         WHERE name='minted_supply' AND value < $1`,
        [app.config.mintMaxSupply],
      );
      if (supplyResult.rowCount === 0) {
        return { error: 'SUPPLY_EXHAUSTED' as const, message: '21M cap reached' };
      }

      await c.query('UPDATE challenges SET claimed_at=now() WHERE id=$1', [ch.id]);

      const tokenId = randomUUID();
      const issuedAt = new Date();
      const ownerHash = createHash('sha256').update(s.email).digest('hex');
      const sig = signTokenPayload(
        { id: tokenId, owner_email_hash: ownerHash, value: 1, issued_at: issuedAt.toISOString() },
        app.config.signingPrivateKeyHex,
      );
      await c.query(
        `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
         VALUES($1, $2, 1, 'VALID', $3, $4)`,
        [tokenId, s.email, issuedAt, sig],
      );
      return { token: { id: tokenId, value: 1, issued_at: issuedAt.toISOString() } };
    });

    if ('error' in result) {
      const status = result.error === 'CHALLENGE_EXPIRED' || result.error === 'SUPPLY_EXHAUSTED' ? 410 : 400;
      return reply.code(status).send(result);
    }
    return result;
  });
}
