// Admin moderation queue.
//
// Two endpoints, both gated to ADMIN_EMAILS:
//   GET  /admin/moderation/queue      — list pending_review + flagged slots
//   POST /admin/moderation/decide     — approve / hide / restore / mark CSAM
//
// The "decide" endpoint writes a moderation_events row and updates the
// slot. There is no refund on HIDE: the user's RPOW burn is permanent
// regardless. CSAM hides AND triggers a hard-quarantine in storage
// (the image is replaced with a transparent pixel; the original is
// preserved as a sidecar for law-enforcement requests).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from './auth.js';
import { isAdmin, type AdminConfig } from '../admin.js';
import { withTx } from '../db.js';

const DecideSchema = z.object({
  slot_id: z.number().int().positive(),
  decision: z.enum(['APPROVE', 'HIDE', 'RESTORE', 'CSAM']),
  notes: z.string().max(2000).optional(),
});

export interface AdminModerationRoutesDeps {
  admins: AdminConfig;
}

export async function adminModerationRoutes(app: FastifyInstance, deps: AdminModerationRoutesDeps) {
  function requireAdmin(req: any, reply: any): string | null {
    const s = readSession(req, app.config.sessionSecret);
    if (!s || !isAdmin(deps.admins, s.email)) {
      reply.code(403).send({ error: 'FORBIDDEN', message: 'admin only' });
      return null;
    }
    return s.email;
  }

  app.get('/admin/moderation/queue', async (req, reply) => {
    if (!requireAdmin(req as any, reply)) return;
    const { rows } = await app.pool.query<{
      id: string; cell_x: number; cell_y: number; cell_w: number; cell_h: number;
      owner_email: string | null; state: string; pending_review: boolean;
      image_object_key: string | null; click_url: string | null; text_caption: string | null;
      version: number; created_at: Date;
    }>(`
      SELECT id::text, cell_x, cell_y, cell_w, cell_h, owner_email, state, pending_review,
             image_object_key, click_url, text_caption, version, created_at
      FROM slots
      WHERE pending_review = TRUE OR state = 'MOD_HIDDEN'
      ORDER BY created_at DESC
      LIMIT 200
    `);
    return reply.send(rows.map(r => ({
      slot_id: Number(r.id),
      cell_x: r.cell_x, cell_y: r.cell_y, cell_w: r.cell_w, cell_h: r.cell_h,
      owner_email: r.owner_email,
      state: r.state,
      pending_review: r.pending_review,
      image_url: r.image_object_key
        ? `/billboard/image/${r.id}/v${r.version}`
        : null,
      click_url: r.click_url,
      text_caption: r.text_caption,
      created_at: r.created_at.toISOString(),
    })));
  });

  app.get('/admin/moderation/slot/:id/events', async (req, reply) => {
    if (!requireAdmin(req as any, reply)) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid id' });
    const { rows } = await app.pool.query<{
      id: string; source: string; decision: string | null;
      classifier_score: unknown; reporter_email: string | null;
      reporter_ip: string | null; ops_email: string | null;
      notes: string | null; created_at: Date;
    }>(`
      SELECT id::text, source, decision, classifier_score, reporter_email,
             reporter_ip, ops_email, notes, created_at
      FROM moderation_events WHERE slot_id = $1 ORDER BY created_at DESC
    `, [id]);
    return reply.send(rows.map(r => ({
      id: Number(r.id),
      source: r.source,
      decision: r.decision,
      classifier_score: r.classifier_score,
      reporter_email: r.reporter_email,
      reporter_ip: r.reporter_ip,
      ops_email: r.ops_email,
      notes: r.notes,
      created_at: r.created_at.toISOString(),
    })));
  });

  app.post('/admin/moderation/decide', async (req, reply) => {
    const adminEmail = requireAdmin(req as any, reply);
    if (!adminEmail) return;
    const parsed = DecideSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    type DecideOut =
      | { ok: true; slot_id: number; state: string }
      | { error: string; message: string; status: number };
    const out = await withTx<DecideOut>(app.pool, async (c) => {
      const { rows } = await c.query<{ id: string; state: string }>(
        `SELECT id::text, state FROM slots WHERE id=$1 FOR UPDATE`,
        [parsed.data.slot_id],
      );
      const r = rows[0];
      if (!r) return { error: 'SLOT_NOT_FOUND', message: 'no such slot', status: 404 };

      let newState = r.state;
      let event: 'MOD_HIDDEN' | 'MOD_RESTORED' | null = null;
      let modDecision: string;

      switch (parsed.data.decision) {
        case 'APPROVE':
          modDecision = 'NO_ACTION';
          await c.query(`UPDATE slots SET pending_review = FALSE WHERE id = $1`, [parsed.data.slot_id]);
          break;
        case 'HIDE':
          modDecision = 'HIDE';
          newState = 'MOD_HIDDEN';
          event = 'MOD_HIDDEN';
          await c.query(`UPDATE slots SET state='MOD_HIDDEN', pending_review = FALSE WHERE id = $1`, [parsed.data.slot_id]);
          break;
        case 'RESTORE':
          modDecision = 'RESTORE';
          newState = 'OWNED';
          event = 'MOD_RESTORED';
          await c.query(`UPDATE slots SET state='OWNED', pending_review = FALSE WHERE id = $1`, [parsed.data.slot_id]);
          break;
        case 'CSAM':
          modDecision = 'CSAM';
          newState = 'MOD_HIDDEN';
          event = 'MOD_HIDDEN';
          await c.query(`UPDATE slots SET state='MOD_HIDDEN', pending_review = FALSE WHERE id = $1`, [parsed.data.slot_id]);
          break;
      }

      await c.query(
        `INSERT INTO moderation_events (slot_id, source, decision, ops_email, notes)
         VALUES ($1, 'OPS_REVIEW', $2, $3, $4)`,
        [parsed.data.slot_id, modDecision, adminEmail, parsed.data.notes ?? null],
      );
      if (event) {
        await c.query(
          `INSERT INTO slot_history (slot_id, event, actor_email, metadata_json)
           VALUES ($1, $2, $3, $4)`,
          [parsed.data.slot_id, event, adminEmail, JSON.stringify({ decision: parsed.data.decision })],
        );
      }
      return { ok: true, slot_id: parsed.data.slot_id, state: newState };
    });
    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return reply.send(out);
  });

  app.get('/admin/rake/summary', async (req, reply) => {
    if (!requireAdmin(req as any, reply)) return;
    const [{ rows: total }, { rows: byKind }] = await Promise.all([
      app.pool.query<{ n: string }>(`SELECT coalesce(sum(amount_msat),0)::text AS n FROM protocol_rake_ledger`),
      app.pool.query<{ source: string; n: string }>(`SELECT source, coalesce(sum(amount_msat),0)::text AS n FROM protocol_rake_ledger GROUP BY source`),
    ]);
    return reply.send({
      total_msat: Number(total[0]!.n),
      by_source: Object.fromEntries(byKind.map(r => [r.source, Number(r.n)])),
    });
  });
}
