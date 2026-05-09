// Billboard routes — claim, edit, list, unlist, takeover, abandon, plus
// public reads (grid, slot detail, summary, canvas image, timestamps).
//
// Concurrency model:
//   * Slot non-overlap is enforced by the slots_no_overlap GiST EXCLUDE
//     constraint — we never check overlap in the app, we just INSERT and
//     handle the 23P01 SQLSTATE that comes back on conflict.
//   * Token burn is via SELECT ... FOR UPDATE SKIP LOCKED. If we can't
//     lock N rows, the user genuinely doesn't have N free tokens and we
//     return INSUFFICIENT_RPOW.
//   * Takeover is atomic: row-lock the slot, debit/credit balances and
//     write the rake row inside one transaction.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import {
  type ImageStore, objectKeyFor, extForContentType,
} from '../billboard/imageStorage.js';
import { moderateImage, moderateUrl, type ModerationConfig } from '../billboard/moderation.js';
import { maskEmail, sha256Hex } from '../billboard/state.js';

export interface BillboardConfig {
  rpowPerCell: number;
  rakeBps: number;
  noListHoldHours: number;
  perEmailOwnedCapCells: number;
  lightningEnabled: boolean;
  storagePublicUrlBase: string | null;
  serverPublicUrl: string;
}

const MAX_IMAGE_BYTES = 256 * 1024;
const ALLOWED_CT = new Set(['image/png', 'image/jpeg', 'image/webp']);

const BboxSchema = {
  cell_x: z.number().int().min(0).max(99),
  cell_y: z.number().int().min(0).max(99),
  cell_w: z.number().int().min(1).max(100),
  cell_h: z.number().int().min(1).max(100),
};

const ClaimSchema = z.object({
  ...BboxSchema,
  image_b64: z.string().min(1),
  image_content_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  click_url: z.string().url().max(512),
  text_caption: z.string().max(80).optional(),
  hover_tooltip: z.string().max(140).optional(),
});

const EditSchema = z.object({
  slot_id: z.number().int().positive(),
  image_b64: z.string().optional(),
  image_content_type: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  click_url: z.string().url().max(512).optional(),
  text_caption: z.string().max(80).optional(),
  hover_tooltip: z.string().max(140).optional(),
});

const ListSchema = z.object({
  slot_id: z.number().int().positive(),
  listing_sats: z.number().int().positive().max(2_100_000_000),
});

const UnlistSchema = z.object({ slot_id: z.number().int().positive() });
const TakeoverSchema = z.object({ slot_id: z.number().int().positive() });
const AbandonSchema = z.object({
  slot_id: z.number().int().positive(),
  confirm: z.literal('I UNDERSTAND THE RPOW BURN IS PERMANENT'),
});

const ReportSchema = z.object({
  reason: z.enum(['NSFW', 'CSAM', 'MALWARE', 'COPYRIGHT', 'IMPERSONATION', 'OTHER']),
  notes: z.string().max(1000).optional(),
});

interface SlotRow {
  id: string;
  cell_x: number; cell_y: number; cell_w: number; cell_h: number;
  owner_email: string | null;
  state: string;
  image_object_key: string | null;
  image_content_type: string | null;
  click_url: string | null;
  text_caption: string | null;
  hover_tooltip: string | null;
  total_rpow_burned: number;
  listing_active: boolean;
  listing_sats: string | null;
  listing_set_at: Date | null;
  pending_review: boolean;
  no_list_until: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function imageUrlFor(
  cfg: BillboardConfig,
  slotId: number,
  version: number,
  imageObjectKey: string | null,
): string | null {
  if (!imageObjectKey) return null;
  if (cfg.storagePublicUrlBase) {
    return `${cfg.storagePublicUrlBase.replace(/\/+$/, '')}/${imageObjectKey}`;
  }
  // Server-side passthrough endpoint.
  return `${cfg.serverPublicUrl.replace(/\/+$/, '')}/billboard/image/${slotId}/v${version}`;
}

function rowToGrid(cfg: BillboardConfig, r: SlotRow) {
  return {
    slot_id: Number(r.id),
    cell_x: r.cell_x, cell_y: r.cell_y, cell_w: r.cell_w, cell_h: r.cell_h,
    state: r.state,
    owner_handle_masked: maskEmail(r.owner_email),
    image_url: imageUrlFor(cfg, Number(r.id), r.version, r.image_object_key),
    click_url: r.click_url,
    listing_sats: r.listing_sats == null ? null : Number(r.listing_sats),
    pending_review: r.pending_review,
    total_rpow_burned: r.total_rpow_burned,
    version: r.version,
  };
}

export interface BillboardRoutesDeps {
  imageStore: ImageStore;
  moderationCfg: ModerationConfig;
  cfg: BillboardConfig;
}

export async function billboardRoutes(app: FastifyInstance, deps: BillboardRoutesDeps) {
  const { imageStore, moderationCfg, cfg } = deps;

  // ── Public reads ──────────────────────────────────────────────────────

  app.get('/billboard/summary', async (_req, reply) => {
    const [
      { rows: cells },
      { rows: rpow },
      { rows: listed },
      { rows: rake },
    ] = await Promise.all([
      app.pool.query<{ n: number }>(`SELECT coalesce(sum(cell_w * cell_h), 0)::int AS n FROM slots WHERE state='OWNED'`),
      app.pool.query<{ n: number }>(`SELECT coalesce(sum(total_rpow_burned), 0)::int AS n FROM slots WHERE state='OWNED'`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM slots WHERE listing_active = TRUE`),
      app.pool.query<{ n: string }>(`SELECT coalesce(sum(amount_msat), 0)::text AS n FROM protocol_rake_ledger`),
    ]);
    const totalCells = 100 * 100;
    return reply.send({
      cells_claimed: cells[0]!.n,
      cells_total: totalCells,
      pixels_claimed: cells[0]!.n * 100,
      total_rpow_burned: rpow[0]!.n,
      slots_listed: listed[0]!.n,
      rake_msat_total: Number(rake[0]!.n),
      config: {
        rpow_per_cell: cfg.rpowPerCell,
        rake_bps: cfg.rakeBps,
        canvas_dim_cells: 100,
        cell_px: 10,
        no_list_hold_hours: cfg.noListHoldHours,
        per_email_owned_cap_cells: cfg.perEmailOwnedCapCells,
        lightning_enabled: cfg.lightningEnabled,
        moderation_enabled: moderationCfg.enabled,
      },
    });
  });

  app.get('/billboard/grid', async (_req, reply) => {
    const { rows } = await app.pool.query<SlotRow>(`
      SELECT id::text, cell_x, cell_y, cell_w, cell_h,
             owner_email, state, image_object_key, image_content_type,
             click_url, text_caption, hover_tooltip,
             total_rpow_burned, listing_active, listing_sats::text AS listing_sats,
             listing_set_at, pending_review, no_list_until, version,
             created_at, updated_at
      FROM slots
      WHERE state IN ('OWNED', 'MOD_HIDDEN')
      ORDER BY id ASC
    `);
    reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=30');
    return reply.send(rows.map(r => rowToGrid(cfg, r)));
  });

  app.get('/billboard/slot/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid id' });
    const { rows } = await app.pool.query<SlotRow>(`
      SELECT id::text, cell_x, cell_y, cell_w, cell_h,
             owner_email, state, image_object_key, image_content_type,
             click_url, text_caption, hover_tooltip,
             total_rpow_burned, listing_active, listing_sats::text AS listing_sats,
             listing_set_at, pending_review, no_list_until, version,
             created_at, updated_at
      FROM slots WHERE id = $1
    `, [id]);
    const r = rows[0];
    if (!r) return reply.code(404).send({ error: 'SLOT_NOT_FOUND', message: 'no such slot' });
    const { rows: hist } = await app.pool.query<{
      event: string; actor_email: string | null; prior_owner_email: string | null;
      rpow_burned: number; sats_paid: string; sats_rake: string; created_at: Date;
    }>(`
      SELECT event, actor_email, prior_owner_email, rpow_burned,
             sats_paid::text AS sats_paid, sats_rake::text AS sats_rake, created_at
      FROM slot_history WHERE slot_id = $1 ORDER BY created_at DESC LIMIT 20
    `, [id]);
    const grid = rowToGrid(cfg, r);
    return reply.send({
      ...grid,
      text_caption: r.text_caption,
      hover_tooltip: r.hover_tooltip,
      no_list_until: r.no_list_until ? r.no_list_until.toISOString() : null,
      updated_at: r.updated_at.toISOString(),
      takeover_count: hist.filter(h => h.event === 'TAKEOVER').length,
      history: hist.map(h => ({
        event: h.event,
        actor_masked: maskEmail(h.actor_email),
        prior_owner_masked: maskEmail(h.prior_owner_email),
        rpow_burned: h.rpow_burned,
        sats_paid: Number(h.sats_paid),
        sats_rake: Number(h.sats_rake),
        at: h.created_at.toISOString(),
      })),
    });
  });

  app.get('/billboard/image/:slotId/v:version', async (req, reply) => {
    const params = req.params as { slotId: string; version: string };
    const slotId = Number(params.slotId);
    const version = Number(params.version);
    if (!Number.isFinite(slotId) || !Number.isFinite(version)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid path' });
    }
    const { rows } = await app.pool.query<{ image_object_key: string | null; image_content_type: string | null; version: number; state: string }>(
      'SELECT image_object_key, image_content_type, version, state FROM slots WHERE id = $1',
      [slotId],
    );
    const row = rows[0];
    if (!row || !row.image_object_key) return reply.code(404).send({ error: 'NOT_FOUND', message: 'no image' });
    if (row.state === 'MOD_HIDDEN') return reply.code(410).send({ error: 'NOT_FOUND', message: 'image removed' });
    if (row.version !== version) {
      // Tell the client which version is current; useful for cache invalidation.
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'stale version', current_version: row.version });
    }
    const stored = await imageStore.get(row.image_object_key);
    if (!stored) return reply.code(404).send({ error: 'NOT_FOUND', message: 'object missing' });
    reply.header('content-type', stored.contentType);
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(stored.bytes);
  });

  // ── State hash + timestamps ──────────────────────────────────────────

  app.get('/billboard/timestamps', async (_req, reply) => {
    const { rows } = await app.pool.query<{
      id: string; snapshot_at: Date; state_sha256: Buffer;
      slot_count: number; total_rpow_burned: string;
      ots_calendar_url: string | null; bitcoin_block_height: number | null;
      bitcoin_block_hash: Buffer | null; upgraded_at: Date | null;
      status: string; has_proof: boolean;
    }>(`
      SELECT id::text, snapshot_at, state_sha256, slot_count, total_rpow_burned::text,
             ots_calendar_url, bitcoin_block_height, bitcoin_block_hash, upgraded_at,
             status, ots_proof_blob IS NOT NULL AS has_proof
      FROM canvas_timestamps ORDER BY snapshot_at DESC LIMIT 365
    `);
    return reply.send(rows.map(r => ({
      id: Number(r.id),
      snapshot_at: r.snapshot_at.toISOString(),
      state_sha256_hex: r.state_sha256.toString('hex'),
      slot_count: r.slot_count,
      total_rpow_burned: Number(r.total_rpow_burned),
      ots_calendar_url: r.ots_calendar_url,
      bitcoin_block_height: r.bitcoin_block_height,
      bitcoin_block_hash_hex: r.bitcoin_block_hash ? r.bitcoin_block_hash.toString('hex') : null,
      upgraded_at: r.upgraded_at ? r.upgraded_at.toISOString() : null,
      status: r.status,
      ots_proof_url: r.has_proof ? `/billboard/timestamps/${r.id}.ots` : null,
    })));
  });

  app.get('/billboard/timestamps/:id.ots', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid id' });
    const { rows } = await app.pool.query<{ ots_proof_blob: Buffer | null; snapshot_at: Date }>(
      'SELECT ots_proof_blob, snapshot_at FROM canvas_timestamps WHERE id = $1',
      [id],
    );
    const r = rows[0];
    if (!r || !r.ots_proof_blob) return reply.code(404).send({ error: 'NOT_FOUND', message: 'proof not available' });
    reply.header('content-type', 'application/octet-stream');
    const day = r.snapshot_at.toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="rpow3-billboard-${day}.ots"`);
    return reply.send(r.ots_proof_blob);
  });

  // ── Mutations ────────────────────────────────────────────────────────

  app.post('/billboard/claim', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = ClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: parsed.error.errors[0]?.message ?? 'invalid body' });
    }
    const b = parsed.data;
    if (b.cell_x + b.cell_w > 100 || b.cell_y + b.cell_h > 100) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'rectangle exceeds canvas' });
    }
    if (!ALLOWED_CT.has(b.image_content_type)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'unsupported image type' });
    }
    let imageBytes: Buffer;
    try { imageBytes = Buffer.from(b.image_b64, 'base64'); }
    catch { return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid base64' }); }
    if (imageBytes.length === 0) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'empty image' });
    }
    if (imageBytes.length > MAX_IMAGE_BYTES) {
      return reply.code(413).send({ error: 'IMAGE_TOO_LARGE', message: `image must be ≤${MAX_IMAGE_BYTES} bytes` });
    }
    if (!sniffImage(imageBytes, b.image_content_type)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'image bytes do not match declared content-type' });
    }

    const cells = b.cell_w * b.cell_h;
    const burnAmount = cells * cfg.rpowPerCell;

    // Moderation BEFORE the DB tx so a slow upstream doesn't hold a row lock.
    const [imgVerdict, urlVerdict] = await Promise.all([
      moderateImage(imageBytes, b.image_content_type, moderationCfg),
      moderateUrl(b.click_url, moderationCfg),
    ]);
    if (!urlVerdict.ok) {
      return reply.code(400).send({ error: 'URL_REJECTED', message: urlVerdict.reason ?? 'click URL rejected' });
    }
    if (imgVerdict.decision === 'reject') {
      return reply.code(400).send({ error: 'IMAGE_REJECTED', message: imgVerdict.reason ?? 'image rejected' });
    }
    const pendingReview = imgVerdict.decision === 'flag';

    const sha = sha256Hex(imageBytes);
    const ext = extForContentType(b.image_content_type);
    const objectKey = `slots/by-sha256/${sha}.${ext}`;

    // Upload before DB tx — orphan on rollback is OK (content-addressed).
    await imageStore.put(objectKey, imageBytes, b.image_content_type);

    type Out =
      | { ok: true; slot_id: number; pending_review: boolean; image_url: string | null; rpow_burned: number; version: number }
      | { error: string; message: string; status: number };

    const out: Out = await withTx(app.pool, async (c) => {
      // Per-email cap: count cells already owned by this user.
      const { rows: ownedRows } = await c.query<{ n: number }>(
        `SELECT coalesce(sum(cell_w * cell_h), 0)::int AS n FROM slots WHERE owner_email=$1 AND state='OWNED'`,
        [s.email],
      );
      const owned = ownedRows[0]!.n;
      if (owned + cells > cfg.perEmailOwnedCapCells) {
        return { error: 'PER_EMAIL_CAP', message: `per-email cap is ${cfg.perEmailOwnedCapCells} cells (you own ${owned}, requested ${cells})`, status: 400 };
      }

      // Insert the slot. Postgres will reject overlap with 23P01.
      let slotId: number;
      try {
        const ins = await c.query<{ id: string; version: number }>(
          `INSERT INTO slots
             (cell_x, cell_y, cell_w, cell_h, owner_email, state,
              image_object_key, image_content_type, click_url,
              text_caption, hover_tooltip, total_rpow_burned, pending_review)
           VALUES ($1,$2,$3,$4,$5,'OWNED',$6,$7,$8,$9,$10,$11,$12)
           RETURNING id::text AS id, version`,
          [
            b.cell_x, b.cell_y, b.cell_w, b.cell_h,
            s.email,
            objectKey,
            b.image_content_type,
            b.click_url,
            b.text_caption ?? null,
            b.hover_tooltip ?? null,
            burnAmount,
            pendingReview,
          ],
        );
        slotId = Number(ins.rows[0]!.id);
      } catch (e: any) {
        if (e?.code === '23P01') {
          return { error: 'SLOT_OVERLAP', message: 'this rectangle overlaps an existing slot', status: 409 };
        }
        throw e;
      }

      // Lock + invalidate burnAmount tokens. Lazy lock: if we can't get
      // burnAmount rows, the user doesn't have the RPOW.
      const { rows: locked } = await c.query<{ id: string }>(
        `SELECT id FROM tokens
           WHERE owner_email=$1 AND state='VALID'
           ORDER BY issued_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [s.email, burnAmount],
      );
      if (locked.length < burnAmount) {
        return {
          error: 'INSUFFICIENT_RPOW',
          message: `claim costs ${burnAmount} RPOW; you have ${locked.length}`,
          status: 400,
        };
      }
      await c.query(
        `UPDATE tokens
           SET state='INVALIDATED', invalidated_at=now(),
               invalidated_for_slot_id=$1, invalidated_reason='BILLBOARD_BURN'
         WHERE id = ANY($2::uuid[])`,
        [slotId, locked.map(r => r.id)],
      );

      const { rows: hist } = await c.query<{ id: string }>(
        `INSERT INTO slot_history (slot_id, event, actor_email, rpow_burned, metadata_json)
         VALUES ($1, 'CLAIM', $2, $3, $4) RETURNING id::text AS id`,
        [slotId, s.email, burnAmount, JSON.stringify({ image_sha256: sha })],
      );
      await c.query(
        `INSERT INTO moderation_events (slot_id, source, decision, classifier_score, reporter_ip, notes)
         VALUES ($1, 'AUTO_SIGHTENGINE', $2, $3, $4, NULL)`,
        [slotId, pendingReview ? 'FLAG' : 'NO_ACTION', JSON.stringify(imgVerdict.scores), req.ip ?? null],
      );
      void hist; // referenced for audit symmetry; not currently used downstream
      return {
        ok: true, slot_id: slotId, pending_review: pendingReview,
        image_url: imageUrlFor(cfg, slotId, 1, objectKey),
        rpow_burned: burnAmount,
        version: 1,
      };
    });

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return reply.code(201).send({
      slot_id: out.slot_id,
      state: 'OWNED',
      pending_review: out.pending_review,
      image_url: out.image_url,
      rpow_burned: out.rpow_burned,
    });
  });

  app.post('/billboard/edit', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = EditSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: parsed.error.errors[0]?.message ?? 'invalid body' });
    }
    const b = parsed.data;
    let newImageKey: string | null = null;
    let newImageCt: string | null = null;
    let pendingReview = false;
    let imgScores: unknown = null;

    if (b.image_b64 !== undefined) {
      if (!b.image_content_type) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'image_content_type required when image_b64 present' });
      }
      let bytes: Buffer;
      try { bytes = Buffer.from(b.image_b64, 'base64'); }
      catch { return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid base64' }); }
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        return reply.code(413).send({ error: 'IMAGE_TOO_LARGE', message: `image must be 1..${MAX_IMAGE_BYTES} bytes` });
      }
      if (!sniffImage(bytes, b.image_content_type)) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'image bytes do not match declared content-type' });
      }
      const verdict = await moderateImage(bytes, b.image_content_type, moderationCfg);
      if (verdict.decision === 'reject') {
        return reply.code(400).send({ error: 'IMAGE_REJECTED', message: verdict.reason ?? 'image rejected' });
      }
      pendingReview = verdict.decision === 'flag';
      imgScores = verdict.scores;
      const sha = sha256Hex(bytes);
      const ext = extForContentType(b.image_content_type);
      newImageKey = `slots/by-sha256/${sha}.${ext}`;
      newImageCt = b.image_content_type;
      await imageStore.put(newImageKey, bytes, b.image_content_type);
    }

    if (b.click_url !== undefined) {
      const v = await moderateUrl(b.click_url, moderationCfg);
      if (!v.ok) return reply.code(400).send({ error: 'URL_REJECTED', message: v.reason ?? 'click URL rejected' });
    }

    type Out =
      | { ok: true; slot_id: number; version: number; pending_review: boolean; image_url: string | null }
      | { error: string; message: string; status: number };

    const out: Out = await withTx(app.pool, async (c) => {
      const { rows } = await c.query<{ id: string; owner_email: string; version: number; image_object_key: string | null }>(
        `SELECT id::text, owner_email, version, image_object_key
         FROM slots WHERE id=$1 FOR UPDATE`,
        [b.slot_id],
      );
      const r = rows[0];
      if (!r) return { error: 'SLOT_NOT_FOUND', message: 'no such slot', status: 404 };
      if (r.owner_email !== s.email) return { error: 'SLOT_NOT_OWNED', message: 'not your slot', status: 403 };

      const sets: string[] = [];
      const args: unknown[] = [b.slot_id];
      const next = (v: unknown) => { args.push(v); return `$${args.length}`; };
      sets.push(`version = version + 1`);
      sets.push(`updated_at = now()`);
      if (newImageKey !== null) {
        sets.push(`image_object_key = ${next(newImageKey)}`);
        sets.push(`image_content_type = ${next(newImageCt)}`);
      }
      if (b.click_url !== undefined) sets.push(`click_url = ${next(b.click_url)}`);
      if (b.text_caption !== undefined) sets.push(`text_caption = ${next(b.text_caption)}`);
      if (b.hover_tooltip !== undefined) sets.push(`hover_tooltip = ${next(b.hover_tooltip)}`);
      if (newImageKey !== null && pendingReview) sets.push(`pending_review = TRUE`);

      const { rows: upd } = await c.query<{ version: number }>(
        `UPDATE slots SET ${sets.join(', ')} WHERE id = $1 RETURNING version`,
        args,
      );
      const version = upd[0]!.version;
      await c.query(
        `INSERT INTO slot_history (slot_id, event, actor_email, metadata_json)
         VALUES ($1, 'EDIT', $2, $3)`,
        [b.slot_id, s.email, JSON.stringify({ new_image: newImageKey != null })],
      );
      if (imgScores) {
        await c.query(
          `INSERT INTO moderation_events (slot_id, source, decision, classifier_score, reporter_ip)
           VALUES ($1, 'AUTO_SIGHTENGINE', $2, $3, $4)`,
          [b.slot_id, pendingReview ? 'FLAG' : 'NO_ACTION', JSON.stringify(imgScores), req.ip ?? null],
        );
      }
      return {
        ok: true,
        slot_id: b.slot_id,
        version,
        pending_review: pendingReview,
        image_url: imageUrlFor(cfg, b.slot_id, version, newImageKey ?? r.image_object_key),
      };
    });
    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return reply.send(out);
  });

  app.post('/billboard/list', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = ListSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    type ListOut =
      | { ok: true; slot_id: number; listing_sats: number }
      | { error: string; message: string; status: number };
    const out = await withTx<ListOut>(app.pool, async (c) => {
      const { rows } = await c.query<{ owner_email: string; no_list_until: Date | null; state: string }>(
        `SELECT owner_email, no_list_until, state FROM slots WHERE id=$1 FOR UPDATE`,
        [parsed.data.slot_id],
      );
      const r = rows[0];
      if (!r) return { error: 'SLOT_NOT_FOUND', message: 'no such slot', status: 404 };
      if (r.owner_email !== s.email) return { error: 'SLOT_NOT_OWNED', message: 'not your slot', status: 403 };
      if (r.state !== 'OWNED') return { error: 'SLOT_LOCKED', message: 'slot is not in OWNED state', status: 400 };
      if (r.no_list_until && r.no_list_until.getTime() > Date.now()) {
        return { error: 'NO_LIST_COOLDOWN', message: `cannot list until ${r.no_list_until.toISOString()}`, status: 400 };
      }
      await c.query(
        `UPDATE slots SET listing_active = TRUE, listing_sats = $2, listing_set_at = now(), updated_at = now()
         WHERE id = $1`,
        [parsed.data.slot_id, parsed.data.listing_sats],
      );
      await c.query(
        `INSERT INTO slot_history (slot_id, event, actor_email, sats_paid)
         VALUES ($1, 'LIST', $2, $3)`,
        [parsed.data.slot_id, s.email, parsed.data.listing_sats],
      );
      return { ok: true, slot_id: parsed.data.slot_id, listing_sats: parsed.data.listing_sats };
    });
    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return reply.send(out);
  });

  app.post('/billboard/unlist', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = UnlistSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    type UnlistOut =
      | { ok: true; slot_id: number }
      | { error: string; message: string; status: number };
    const out = await withTx<UnlistOut>(app.pool, async (c) => {
      const { rows } = await c.query<{ owner_email: string; listing_active: boolean }>(
        `SELECT owner_email, listing_active FROM slots WHERE id=$1 FOR UPDATE`,
        [parsed.data.slot_id],
      );
      const r = rows[0];
      if (!r) return { error: 'SLOT_NOT_FOUND', message: 'no such slot', status: 404 };
      if (r.owner_email !== s.email) return { error: 'SLOT_NOT_OWNED', message: 'not your slot', status: 403 };
      await c.query(
        `UPDATE slots SET listing_active = FALSE, listing_sats = NULL, updated_at = now() WHERE id = $1`,
        [parsed.data.slot_id],
      );
      await c.query(
        `INSERT INTO slot_history (slot_id, event, actor_email) VALUES ($1, 'UNLIST', $2)`,
        [parsed.data.slot_id, s.email],
      );
      return { ok: true, slot_id: parsed.data.slot_id };
    });
    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return reply.send(out);
  });

  app.post('/billboard/takeover', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    if (!cfg.lightningEnabled) {
      return reply.code(503).send({ error: 'LIGHTNING_DISABLED', message: 'takeovers require Lightning, currently disabled' });
    }
    const parsed = TakeoverSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    type TakeoverOut =
      | { ok: true; slot_id: number; new_owner_email: string; sats_paid: number; sats_rake: number; seller_credit_sats: number }
      | { error: string; message: string; status: number };
    const out = await withTx<TakeoverOut>(app.pool, async (c) => {
      const { rows } = await c.query<{ owner_email: string; state: string; listing_active: boolean; listing_sats: string | null; cell_w: number; cell_h: number }>(
        `SELECT owner_email, state, listing_active, listing_sats::text AS listing_sats, cell_w, cell_h
         FROM slots WHERE id=$1 FOR UPDATE`,
        [parsed.data.slot_id],
      );
      const r = rows[0];
      if (!r) return { error: 'SLOT_NOT_FOUND', message: 'no such slot', status: 404 };
      if (r.owner_email === s.email) return { error: 'BAD_REQUEST', message: 'cannot take over your own slot', status: 400 };
      if (r.state !== 'OWNED') return { error: 'SLOT_LOCKED', message: 'slot is not transferable', status: 400 };
      if (!r.listing_active || r.listing_sats == null) {
        return { error: 'SLOT_NOT_LISTED', message: 'slot is not for sale', status: 400 };
      }

      const sats = Number(r.listing_sats);
      if (!Number.isFinite(sats) || sats <= 0) {
        return { error: 'BAD_REQUEST', message: 'invalid listing price', status: 400 };
      }
      const totalMsat = sats * 1000;
      const rakeBps = cfg.rakeBps;
      const rakeMsat = Math.floor((totalMsat * rakeBps) / 10_000);
      const sellerMsat = totalMsat - rakeMsat;

      // Per-email cap on the buyer's side (takeover transfers ownership).
      const cells = r.cell_w * r.cell_h;
      const { rows: ownedRows } = await c.query<{ n: number }>(
        `SELECT coalesce(sum(cell_w * cell_h), 0)::int AS n FROM slots WHERE owner_email=$1 AND state='OWNED'`,
        [s.email],
      );
      if ((ownedRows[0]!.n + cells) > cfg.perEmailOwnedCapCells) {
        return { error: 'PER_EMAIL_CAP', message: `per-email cap is ${cfg.perEmailOwnedCapCells} cells`, status: 400 };
      }

      // Lock buyer balance row, ensure sufficient.
      const { rows: balRows } = await c.query<{ balance_msat: string }>(
        `SELECT balance_msat::text AS balance_msat FROM ln_user_balances WHERE user_email=$1 FOR UPDATE`,
        [s.email],
      );
      if (!balRows[0]) return { error: 'INSUFFICIENT_BALANCE_SATS', message: 'no Lightning balance — receive sats first', status: 400 };
      if (BigInt(balRows[0].balance_msat) < BigInt(totalMsat)) {
        return { error: 'INSUFFICIENT_BALANCE_SATS', message: `need ${sats} sats; have ${Math.floor(Number(balRows[0].balance_msat) / 1000)}`, status: 400 };
      }
      // Ensure seller has a balance row too (auto-create if missing).
      await c.query(
        `INSERT INTO ln_user_balances (user_email, ln_address_handle)
         VALUES ($1, substr(md5(random()::text || clock_timestamp()::text), 1, 8))
         ON CONFLICT (user_email) DO NOTHING`,
        [r.owner_email],
      );

      // History first so we can reference its id from rake/ledger rows.
      const { rows: hist } = await c.query<{ id: string }>(
        `INSERT INTO slot_history (slot_id, event, actor_email, prior_owner_email, sats_paid, sats_rake)
         VALUES ($1, 'TAKEOVER', $2, $3, $4, $5) RETURNING id::text AS id`,
        [parsed.data.slot_id, s.email, r.owner_email, sats, Math.floor(rakeMsat / 1000)],
      );
      const historyId = Number(hist[0]!.id);

      // Debit buyer.
      await c.query(
        `UPDATE ln_user_balances
           SET balance_msat = balance_msat - $1,
               total_out_msat = total_out_msat + $1,
               updated_at = now()
         WHERE user_email = $2`,
        [totalMsat, s.email],
      );
      await c.query(
        `INSERT INTO ln_ledger_entries (user_email, delta_msat, reason, ref_slot_id, ref_history_id)
         VALUES ($1, $2, 'BILLBOARD_TAKEOVER_DEBIT', $3, $4)`,
        [s.email, -totalMsat, parsed.data.slot_id, historyId],
      );

      // Credit seller.
      await c.query(
        `UPDATE ln_user_balances
           SET balance_msat = balance_msat + $1,
               total_in_msat = total_in_msat + $1,
               updated_at = now()
         WHERE user_email = $2`,
        [sellerMsat, r.owner_email],
      );
      await c.query(
        `INSERT INTO ln_ledger_entries (user_email, delta_msat, reason, ref_slot_id, ref_history_id)
         VALUES ($1, $2, 'BILLBOARD_TAKEOVER_CREDIT', $3, $4)`,
        [r.owner_email, sellerMsat, parsed.data.slot_id, historyId],
      );

      // Rake.
      if (rakeMsat > 0) {
        await c.query(
          `INSERT INTO protocol_rake_ledger (source, ref_history_id, amount_msat)
           VALUES ('TAKEOVER', $1, $2)`,
          [historyId, rakeMsat],
        );
      }

      // Transfer ownership + reset listing + start anti-flip cooldown.
      const noListUntil = new Date(Date.now() + cfg.noListHoldHours * 3600 * 1000);
      await c.query(
        `UPDATE slots
           SET owner_email = $2, listing_active = FALSE, listing_sats = NULL,
               no_list_until = $3, updated_at = now()
         WHERE id = $1`,
        [parsed.data.slot_id, s.email, noListUntil],
      );
      return {
        ok: true,
        slot_id: parsed.data.slot_id,
        new_owner_email: s.email,
        sats_paid: sats,
        sats_rake: Math.floor(rakeMsat / 1000),
        seller_credit_sats: Math.floor(sellerMsat / 1000),
      };
    });
    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return reply.send(out);
  });

  app.post('/billboard/abandon', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = AbandonSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: 'confirm must be exactly "I UNDERSTAND THE RPOW BURN IS PERMANENT"',
      });
    }
    type AbandonOut =
      | { ok: true; slot_id: number }
      | { error: string; message: string; status: number };
    const out = await withTx<AbandonOut>(app.pool, async (c) => {
      const { rows } = await c.query<{ owner_email: string; state: string }>(
        `SELECT owner_email, state FROM slots WHERE id=$1 FOR UPDATE`,
        [parsed.data.slot_id],
      );
      const r = rows[0];
      if (!r) return { error: 'SLOT_NOT_FOUND', message: 'no such slot', status: 404 };
      if (r.owner_email !== s.email) return { error: 'SLOT_NOT_OWNED', message: 'not your slot', status: 403 };
      if (r.state !== 'OWNED') return { error: 'SLOT_LOCKED', message: 'slot already abandoned or hidden', status: 400 };
      await c.query(
        `UPDATE slots
           SET state = 'EMPTY', owner_email = NULL,
               image_object_key = NULL, image_content_type = NULL, click_url = NULL,
               text_caption = NULL, hover_tooltip = NULL,
               listing_active = FALSE, listing_sats = NULL,
               updated_at = now()
         WHERE id = $1`,
        [parsed.data.slot_id],
      );
      await c.query(
        `INSERT INTO slot_history (slot_id, event, actor_email) VALUES ($1, 'ABANDON', $2)`,
        [parsed.data.slot_id, s.email],
      );
      return { ok: true, slot_id: parsed.data.slot_id };
    });
    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return reply.send(out);
  });

  app.post('/billboard/slot/:id/report', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid id' });
    const parsed = ReportSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const session = readSession(req as any, app.config.sessionSecret);
    const ip = req.ip ?? null;

    const { rowCount } = await app.pool.query('SELECT 1 FROM slots WHERE id=$1', [id]);
    if (!rowCount) return reply.code(404).send({ error: 'SLOT_NOT_FOUND', message: 'no such slot' });

    await app.pool.query(
      `INSERT INTO moderation_events
         (slot_id, source, decision, reporter_email, reporter_ip, notes, classifier_score)
       VALUES ($1, 'USER_REPORT', NULL, $2, $3, $4, $5)`,
      [id, session?.email ?? null, ip, parsed.data.notes ?? null, JSON.stringify({ reason: parsed.data.reason })],
    );
    // Mark for review so it shows up in the admin queue.
    await app.pool.query(`UPDATE slots SET pending_review = TRUE WHERE id = $1`, [id]);
    return reply.code(202).send({ ok: true });
  });

  // ── State hash (tiny helper) ─────────────────────────────────────────

  app.get('/billboard/state-hash', async (_req, reply) => {
    // A *current* hash, computed live (not the daily-stamped one). This
    // exists so the front-end can compare its rendered state to what the
    // server sees, and so the daily-stamp page can show "current state
    // hash so you can see what tonight's stamp will commit to".
    const { rows } = await app.pool.query<{ id: string; cell_x: number; cell_y: number; cell_w: number; cell_h: number; click_url: string | null; image_object_key: string | null; owner_email: string | null; total_rpow_burned: number }>(`
      SELECT id::text AS id, cell_x, cell_y, cell_w, cell_h, click_url, image_object_key, owner_email, total_rpow_burned
      FROM slots WHERE state='OWNED' AND pending_review = FALSE
      ORDER BY cell_y, cell_x, id
    `);
    const lines: string[] = [];
    let totalRpow = 0;
    for (const r of rows) {
      totalRpow += r.total_rpow_burned;
      lines.push([
        r.id, r.cell_x, r.cell_y, r.cell_w, r.cell_h,
        r.image_object_key ? createHash('sha256').update(r.image_object_key).digest('hex') : ''.padEnd(64, '0'),
        r.click_url ?? '',
        r.owner_email ? createHash('sha256').update(r.owner_email).digest('hex') : ''.padEnd(64, '0'),
      ].join('\t'));
    }
    lines.push(`#total_rpow_burned=${totalRpow}`);
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    const hash = createHash('sha256').update(buf).digest('hex');
    return reply.send({
      state_sha256_hex: hash,
      slot_count: rows.length,
      total_rpow_burned: totalRpow,
      generated_at: new Date().toISOString(),
    });
  });

  void randomUUID; // (silence "unused import" if dropped later)
}

/**
 * Sniff image bytes against the declared content-type. Each format has a
 * distinctive header — we only check the magic bytes, not the full
 * structure (we trust the moderation pipeline to catch corrupt content).
 */
function sniffImage(b: Buffer, ct: string): boolean {
  if (b.length < 12) return false;
  if (ct === 'image/png') {
    return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  }
  if (ct === 'image/jpeg') {
    return b[0] === 0xff && b[1] === 0xd8;
  }
  if (ct === 'image/webp') {
    return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  }
  return false;
}
