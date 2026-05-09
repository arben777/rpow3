// Lightning routes — custodial sub-ledger over a single phoenixd channel.
//
// Endpoints:
//   GET  /ln/balance                     — current balance + LN address
//   POST /ln/rename                      — one-shot LN address handle rename
//   POST /ln/redeem                      — outbound payout (1% rake)
//   GET  /ln/payouts                     — user's payout history
//   GET  /ln/payout/:id                  — single payout state
//   GET  /.well-known/lnurlp/:handle     — LUD-16 / LUD-06 payRequest
//   GET  /lnurl/:handle/callback         — LUD-06 callback (issues invoice)
//   POST /webhooks/phoenixd/:secret      — phoenixd payment notifications
//
// All endpoints (other than the LUD-16 well-known which is intentionally
// public) honor LIGHTNING_ENABLED=false by returning 503 LIGHTNING_DISABLED.
//
// Currency unit is msat throughout. 1 sat = 1000 msat. The 1% rake on
// every outbound payment (and on takeover proceeds, in billboard.ts) is
// configurable via RAKE_BPS; default 100 = 1.00%.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { ensureLnUserBalance, generateLnHandle, rakeOf } from '../lightning/ledger.js';
import type { PhoenixdClient } from '../lightning/phoenixd.js';

export interface LightningConfig {
  enabled: boolean;
  domain: string;
  rakeBps: number;
  maxBalanceMsat: number;
  maxPayout24hMsat: number;
  webhookSecret: string;
}

export interface LightningRoutesDeps {
  cfg: LightningConfig;
  phoenixd: PhoenixdClient | null;
}

const RedeemSchema = z.object({
  destination: z.string().min(1),
  amount_msat: z.number().int().positive(),
});

const RenameSchema = z.object({
  handle: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
});

export async function lightningRoutes(app: FastifyInstance, deps: LightningRoutesDeps) {
  const { cfg, phoenixd } = deps;

  function disabledOr<T>(reply: any, fn: () => Promise<T>): Promise<T | undefined> {
    if (!cfg.enabled || !phoenixd) {
      reply.code(503).send({ error: 'LIGHTNING_DISABLED', message: 'Lightning is not enabled on this server' });
      return Promise.resolve(undefined);
    }
    return fn();
  }

  // ── Public LUD-16 well-known ─────────────────────────────────────────
  app.get('/.well-known/lnurlp/:handle', async (req, reply) => {
    const handle = String((req.params as { handle: string }).handle).toLowerCase();
    const { rows } = await app.pool.query<{ user_email: string }>(
      'SELECT user_email FROM ln_user_balances WHERE ln_address_handle = $1',
      [handle],
    );
    if (!rows[0]) return reply.code(404).send({ status: 'ERROR', reason: 'unknown handle' });

    // Even if LIGHTNING_ENABLED is false, we can still answer the
    // well-known with a metadata stub so wallets discover the address.
    // The actual callback is gated below.
    const callbackUrl = `${app.config.magicLinkBaseUrl}/lnurl/${encodeURIComponent(handle)}/callback`;
    const lnAddress = `${handle}@${cfg.domain}`;
    const metadata = JSON.stringify([
      ['text/identifier', lnAddress],
      ['text/plain', `Pay ${lnAddress} on rpow3.com`],
    ]);
    return reply.send({
      status: 'OK',
      tag: 'payRequest',
      callback: callbackUrl,
      // 1 sat min, 21M sat max — phoenixd will refuse anything it can't route.
      minSendable: 1000,
      maxSendable: 21_000_000_000,
      metadata,
      commentAllowed: 144,
    });
  });

  app.get('/lnurl/:handle/callback', async (req, reply) => {
    if (!cfg.enabled || !phoenixd) {
      return reply.code(503).send({ status: 'ERROR', reason: 'Lightning is not enabled' });
    }
    const handle = String((req.params as { handle: string }).handle).toLowerCase();
    const amountStr = (req.query as Record<string, string>).amount;
    const amountMsat = Number(amountStr);
    if (!Number.isFinite(amountMsat) || amountMsat < 1000) {
      return reply.code(400).send({ status: 'ERROR', reason: 'amount must be >= 1000 msat' });
    }
    const comment = String((req.query as Record<string, string>).comment ?? '').slice(0, 144);

    const { rows } = await app.pool.query<{ user_email: string; balance_msat: string }>(
      'SELECT user_email, balance_msat::text FROM ln_user_balances WHERE ln_address_handle = $1',
      [handle],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ status: 'ERROR', reason: 'unknown handle' });
    if (BigInt(row.balance_msat) + BigInt(amountMsat) > BigInt(cfg.maxBalanceMsat)) {
      return reply.code(400).send({ status: 'ERROR', reason: 'recipient balance cap reached' });
    }

    const lnAddress = `${handle}@${cfg.domain}`;
    const metadata = JSON.stringify([
      ['text/identifier', lnAddress],
      ['text/plain', comment ? `Pay ${lnAddress}: ${comment}` : `Pay ${lnAddress} on rpow3.com`],
    ]);
    const descriptionHash = createHash('sha256').update(metadata).digest();
    const externalId = `lnurl:${handle}:${createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
    const amountSat = Math.floor(amountMsat / 1000);

    const inv = await phoenixd.createInvoice({
      amountSat,
      descriptionHash,
      externalId,
      expirySeconds: 3600,
    });

    await app.pool.query(
      `INSERT INTO ln_invoices (user_email, payment_hash, amount_msat, description_hash, bolt11, external_id)
       VALUES ($1, decode($2, 'hex'), $3, $4, $5, $6)`,
      [row.user_email, inv.paymentHash, amountMsat, descriptionHash, inv.serialized, externalId],
    );
    return reply.send({ status: 'OK', pr: inv.serialized, routes: [] });
  });

  // ── Authenticated user-facing endpoints ──────────────────────────────

  app.get('/ln/balance', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const balance = await withTx(app.pool, async (c) => {
      const { handle } = await ensureLnUserBalance(c, s.email);
      const { rows } = await c.query<{
        balance_msat: string; total_in_msat: string; total_out_msat: string;
        ln_address_renamed: boolean;
      }>(
        `SELECT balance_msat::text, total_in_msat::text, total_out_msat::text, ln_address_renamed
         FROM ln_user_balances WHERE user_email=$1`,
        [s.email],
      );
      const r = rows[0]!;
      const { rows: payoutRows } = await c.query<{ n: string }>(
        `SELECT coalesce(sum(amount_msat + rake_msat),0)::text AS n FROM ln_payouts
         WHERE user_email=$1 AND state IN ('PENDING','SUCCEEDED')
           AND created_at > now() - interval '24 hours'`,
        [s.email],
      );
      return {
        balance_msat: Number(r.balance_msat),
        ln_address: `${handle}@${cfg.domain}`,
        ln_address_handle: handle,
        ln_address_renamed: r.ln_address_renamed,
        total_in_msat: Number(r.total_in_msat),
        total_out_msat: Number(r.total_out_msat),
        payouts_24h_msat: Number(payoutRows[0]!.n),
        max_balance_msat: cfg.maxBalanceMsat,
        max_payout_24h_msat: cfg.maxPayout24hMsat,
        enabled: cfg.enabled,
      };
    });
    return reply.send(balance);
  });

  app.post('/ln/rename', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = RenameSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid handle' });

    type RenameOut =
      | { ok: true; handle: string; ln_address: string }
      | { error: string; message: string; status: number };
    const out = await withTx<RenameOut>(app.pool, async (c) => {
      await ensureLnUserBalance(c, s.email);
      const { rows: cur } = await c.query<{ ln_address_renamed: boolean }>(
        `SELECT ln_address_renamed FROM ln_user_balances WHERE user_email=$1 FOR UPDATE`,
        [s.email],
      );
      if (cur[0]!.ln_address_renamed) {
        return { error: 'CONFLICT', message: 'rename already used (one rename per account)', status: 409 };
      }
      try {
        await c.query(
          `UPDATE ln_user_balances SET ln_address_handle = $2, ln_address_renamed = TRUE, updated_at = now()
           WHERE user_email = $1`,
          [s.email, parsed.data.handle],
        );
      } catch (e: any) {
        if (e?.code === '23505') {
          return { error: 'CONFLICT', message: 'handle already taken', status: 409 };
        }
        throw e;
      }
      return { ok: true, handle: parsed.data.handle, ln_address: `${parsed.data.handle}@${cfg.domain}` };
    });
    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return reply.send(out);
  });

  app.post('/ln/redeem', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    if (!cfg.enabled || !phoenixd) {
      return reply.code(503).send({ error: 'LIGHTNING_DISABLED', message: 'Lightning is not enabled' });
    }
    const parsed = RedeemSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const amountMsat = parsed.data.amount_msat;
    const rakeMsatVal = rakeOf(amountMsat, cfg.rakeBps);
    const totalDebitMsat = amountMsat + rakeMsatVal;

    // 24h cap.
    const { rows: usage } = await app.pool.query<{ n: string }>(
      `SELECT coalesce(sum(amount_msat + rake_msat),0)::text AS n FROM ln_payouts
       WHERE user_email=$1 AND state IN ('PENDING','SUCCEEDED')
         AND created_at > now() - interval '24 hours'`,
      [s.email],
    );
    if (BigInt(usage[0]!.n) + BigInt(totalDebitMsat) > BigInt(cfg.maxPayout24hMsat)) {
      return reply.code(400).send({ error: 'PAYOUT_LIMIT', message: '24h payout cap reached' });
    }

    // Reserve balance + create PENDING payout in one tx.
    type ReserveOut =
      | { ok: true; payout_id: number }
      | { error: string; message: string; status: number };
    const reserved = await withTx<ReserveOut>(app.pool, async (c) => {
      await ensureLnUserBalance(c, s.email);
      const { rows: bal } = await c.query<{ balance_msat: string }>(
        `SELECT balance_msat::text FROM ln_user_balances WHERE user_email=$1 FOR UPDATE`,
        [s.email],
      );
      if (BigInt(bal[0]!.balance_msat) < BigInt(totalDebitMsat)) {
        return { error: 'INSUFFICIENT_BALANCE_SATS', message: 'insufficient balance', status: 400 };
      }
      await c.query(
        `UPDATE ln_user_balances
           SET balance_msat = balance_msat - $1,
               total_out_msat = total_out_msat + $1,
               updated_at = now()
         WHERE user_email = $2`,
        [totalDebitMsat, s.email],
      );
      const { rows: ins } = await c.query<{ id: string }>(
        `INSERT INTO ln_payouts (user_email, destination, amount_msat, rake_msat, state)
         VALUES ($1,$2,$3,$4,'PENDING') RETURNING id::text AS id`,
        [s.email, parsed.data.destination, amountMsat, rakeMsatVal],
      );
      const payoutId = Number(ins[0]!.id);
      await c.query(
        `INSERT INTO ln_ledger_entries (user_email, delta_msat, reason, ref_payout_id)
         VALUES ($1, $2, 'LN_PAYMENT_SENT', $3)`,
        [s.email, -amountMsat, payoutId],
      );
      if (rakeMsatVal > 0) {
        await c.query(
          `INSERT INTO protocol_rake_ledger (source, ref_payout_id, amount_msat) VALUES ('REDEEM', $1, $2)`,
          [payoutId, rakeMsatVal],
        );
        await c.query(
          `INSERT INTO ln_ledger_entries (user_email, delta_msat, reason, ref_payout_id)
           VALUES ($1, $2, 'BILLBOARD_RAKE', $3)`,
          [s.email, -rakeMsatVal, payoutId],
        );
      }
      return { ok: true, payout_id: payoutId };
    });
    if ('error' in reserved) return reply.code(reserved.status).send({ error: reserved.error, message: reserved.message });

    // Fire phoenixd outbound. On failure refund the reserved balance.
    const isLnAddress = parsed.data.destination.includes('@');
    try {
      const sendAmountSat = Math.floor(amountMsat / 1000);
      const paid = isLnAddress
        ? await phoenixd.payLnAddress({ address: parsed.data.destination, amountSat: sendAmountSat, message: 'rpow3 redeem' })
        : await phoenixd.payInvoice({ invoice: parsed.data.destination, amountSat: sendAmountSat });
      const lnFeeMsat = paid.routingFeeSat * 1000;
      await app.pool.query(
        `UPDATE ln_payouts SET state='SUCCEEDED', settled_at=now(), phoenixd_payment_id=$2, ln_fee_msat=$3
         WHERE id=$1`,
        [reserved.payout_id, paid.paymentId, lnFeeMsat],
      );
      return reply.code(202).send({ payout_id: reserved.payout_id, state: 'SUCCEEDED' });
    } catch (e: any) {
      app.log.warn({ err: String(e), payout_id: reserved.payout_id }, 'phoenixd payout failed; refunding');
      await withTx(app.pool, async (c) => {
        await c.query(
          `UPDATE ln_payouts SET state='FAILED', settled_at=now(), failure_reason=$2 WHERE id=$1`,
          [reserved.payout_id, String(e?.message ?? e).slice(0, 500)],
        );
        await c.query(
          `UPDATE ln_user_balances
             SET balance_msat = balance_msat + $1, total_out_msat = total_out_msat - $1, updated_at = now()
           WHERE user_email = $2`,
          [totalDebitMsat, s.email],
        );
        await c.query(
          `INSERT INTO ln_ledger_entries (user_email, delta_msat, reason, ref_payout_id)
           VALUES ($1, $2, 'REDEEM_REFUND', $3)`,
          [s.email, totalDebitMsat, reserved.payout_id],
        );
      });
      return reply.code(202).send({ payout_id: reserved.payout_id, state: 'FAILED' });
    }
  });

  app.get('/ln/payout/:id', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid id' });
    const { rows } = await app.pool.query<{
      id: string; destination: string;
      amount_msat: string; rake_msat: string; ln_fee_msat: string | null;
      state: string; failure_reason: string | null;
      created_at: Date; settled_at: Date | null;
    }>(
      `SELECT id::text, destination, amount_msat::text, rake_msat::text, ln_fee_msat::text,
              state, failure_reason, created_at, settled_at
       FROM ln_payouts WHERE id=$1 AND user_email=$2`,
      [id, s.email],
    );
    const r = rows[0];
    if (!r) return reply.code(404).send({ error: 'NOT_FOUND', message: 'no such payout' });
    return reply.send({
      payout_id: Number(r.id),
      destination: r.destination,
      amount_msat: Number(r.amount_msat),
      rake_msat: Number(r.rake_msat),
      ln_fee_msat: r.ln_fee_msat == null ? null : Number(r.ln_fee_msat),
      state: r.state,
      failure_reason: r.failure_reason,
      created_at: r.created_at.toISOString(),
      settled_at: r.settled_at ? r.settled_at.toISOString() : null,
    });
  });

  app.get('/ln/payouts', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const { rows } = await app.pool.query<{
      id: string; destination: string; amount_msat: string; rake_msat: string;
      ln_fee_msat: string | null; state: string; failure_reason: string | null;
      created_at: Date; settled_at: Date | null;
    }>(
      `SELECT id::text, destination, amount_msat::text, rake_msat::text, ln_fee_msat::text,
              state, failure_reason, created_at, settled_at
       FROM ln_payouts WHERE user_email=$1 ORDER BY created_at DESC LIMIT 100`,
      [s.email],
    );
    return reply.send(rows.map(r => ({
      payout_id: Number(r.id),
      destination: r.destination,
      amount_msat: Number(r.amount_msat),
      rake_msat: Number(r.rake_msat),
      ln_fee_msat: r.ln_fee_msat == null ? null : Number(r.ln_fee_msat),
      state: r.state,
      failure_reason: r.failure_reason,
      created_at: r.created_at.toISOString(),
      settled_at: r.settled_at ? r.settled_at.toISOString() : null,
    })));
  });

  // ── phoenixd webhook ─────────────────────────────────────────────────
  // phoenix.conf sets `webhook=https://api.rpow3.com/webhooks/phoenixd/<secret>`.
  // We require the path-segment secret to match WEBHOOK_SECRET; the
  // POST body is JSON in phoenixd's standard format. Idempotency:
  // crediting is keyed by payment_hash so a replayed webhook is harmless.
  app.post('/webhooks/phoenixd/:secret', async (req, reply) => {
    const provided = String((req.params as { secret: string }).secret);
    if (!cfg.webhookSecret || provided !== cfg.webhookSecret) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'bad webhook secret' });
    }
    const body = (req.body ?? {}) as {
      type?: string;
      paymentHash?: string;
      amountSat?: number;
      externalId?: string;
    };
    if (body.type !== 'payment_received' || !body.paymentHash || !body.externalId) {
      return reply.code(202).send({ ok: true, ignored: true });
    }
    const payHash = Buffer.from(body.paymentHash, 'hex');
    const receivedMsat = Math.max(0, Number(body.amountSat ?? 0)) * 1000;

    await withTx(app.pool, async (c) => {
      // Idempotency: ledger entry by payment hash.
      const { rows: dup } = await c.query(
        `SELECT 1 FROM ln_ledger_entries WHERE ref_invoice_hash = $1 AND reason='LN_PAYMENT_RECEIVED'`,
        [payHash],
      );
      if (dup.length > 0) return;

      const { rows } = await c.query<{ user_email: string; amount_msat: string }>(
        `UPDATE ln_invoices
            SET state='PAID', paid_at=now()
          WHERE payment_hash = $1
          RETURNING user_email, amount_msat::text`,
        [payHash],
      );
      const inv = rows[0];
      if (!inv) {
        // Unknown invoice — this could be a manual phoenixd payment; ignore.
        return;
      }
      const credit = Math.min(receivedMsat, Number(inv.amount_msat));
      await c.query(
        `UPDATE ln_user_balances
            SET balance_msat = balance_msat + $1,
                total_in_msat = total_in_msat + $1,
                updated_at = now()
          WHERE user_email = $2`,
        [credit, inv.user_email],
      );
      await c.query(
        `INSERT INTO ln_ledger_entries (user_email, delta_msat, reason, ref_invoice_hash)
         VALUES ($1, $2, 'LN_PAYMENT_RECEIVED', $3)`,
        [inv.user_email, credit, payHash],
      );
    });
    return reply.code(202).send({ ok: true });
  });

  void disabledOr;
  void generateLnHandle;
}
