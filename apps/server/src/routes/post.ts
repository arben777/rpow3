import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';

// Hashcash-as-stamps. POST /post burns one VALID token and inserts a public
// post in the same transaction. Anyone can boost any post by burning more
// tokens (raises stake, raises feed rank). Anyone can graveyard a post by
// burning exactly 2× its current stake — it's deleted forever.

const PostBody = z.object({
  body: z.string().min(1).max(280),
  idempotency_key: z.string().min(8).max(80),
});

const BoostBody = z.object({
  amount: z.number().int().positive().max(1_000_000),
  idempotency_key: z.string().min(8).max(80),
});

const GraveyardBody = z.object({
  idempotency_key: z.string().min(8).max(80),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Strip ASCII control characters except newline (0x0A) and tab (0x09).
function sanitize(s: string): string {
  return s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
}

interface PostRow {
  id: string;
  author_email: string;
  body: string | null;
  token_id: string;
  created_at: Date;
  stake: number;
  graveyard_at: Date | null;
  graveyard_by_email: string | null;
  graveyard_stake: number | null;
}

function toSummary(r: PostRow) {
  return {
    id: r.id,
    author_email: r.author_email,
    body: r.body,
    token_id: r.token_id,
    created_at: r.created_at.toISOString(),
    stake: r.stake,
    graveyard_at: r.graveyard_at ? r.graveyard_at.toISOString() : null,
    graveyard_by_email: r.graveyard_by_email,
    graveyard_stake: r.graveyard_stake,
  };
}

const POST_COLS = `id, author_email, body, token_id, created_at, stake,
  graveyard_at, graveyard_by_email, graveyard_stake`;

export async function postRoutes(app: FastifyInstance) {
  app.post('/post', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const author = s.email;
    const body = sanitize(parsed.data.body);
    const idem = parsed.data.idempotency_key;
    if (body.length === 0) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'empty post' });

    type Result =
      | { ok: true; post: ReturnType<typeof toSummary> }
      | { error: 'INSUFFICIENT_BALANCE' | 'BAD_REQUEST'; message: string; status: number };

    let out!: Result;
    try {
      out = await withTx<Result>(app.pool, async (c) => {
        const dup = await c.query<PostRow>(
          `SELECT ${POST_COLS} FROM posts WHERE idempotency_key=$1`, [idem],
        );
        if (dup.rows[0]) {
          if (dup.rows[0].author_email !== author || dup.rows[0].body !== body) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return { ok: true as const, post: toSummary(dup.rows[0]) };
        }

        const lockSql = `SELECT id FROM tokens
          WHERE owner_email=$1 AND state='VALID'
          ORDER BY issued_at ASC
          LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const { rows: locked } = await c.query<{ id: string }>(lockSql, [author]);
        if (locked.length < 1) return { error: 'INSUFFICIENT_BALANCE' as const, message: 'no valid tokens to burn', status: 400 };

        const tokenId = locked[0]!.id;
        const postId = randomUUID();
        await c.query(`UPDATE tokens SET state='BURNED', invalidated_at=now() WHERE id=$1`, [tokenId]);
        const ins = await c.query<PostRow>(
          `INSERT INTO posts(id, author_email, token_id, body, idempotency_key)
           VALUES($1,$2,$3,$4,$5) RETURNING ${POST_COLS}`,
          [postId, author, tokenId, body, idem],
        );
        return { ok: true as const, post: toSummary(ins.rows[0]!) };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        const { rows } = await app.pool.query<PostRow>(
          `SELECT ${POST_COLS} FROM posts WHERE idempotency_key=$1`, [idem],
        );
        if (rows[0]) return reply.send({ ok: true, post: toSummary(rows[0]) });
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });

  app.post<{ Params: { id: string } }>('/post/:id/boost', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = BoostBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const postId = req.params.id;
    if (!UUID_RE.test(postId)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid post id' });

    const actor = s.email;
    const amount = parsed.data.amount;
    const idem = parsed.data.idempotency_key;

    type Result =
      | { ok: true; post_id: string; new_stake: number; action_id: string }
      | { error: 'BAD_REQUEST' | 'INSUFFICIENT_BALANCE' | 'POST_NOT_FOUND' | 'POST_GRAVEYARDED'; message: string; status: number };

    let out!: Result;
    try {
      out = await withTx<Result>(app.pool, async (c) => {
        const dup = await c.query<{ id: string; post_id: string; amount: number; actor_email: string; kind: string }>(
          `SELECT id, post_id, amount, actor_email, kind FROM post_actions WHERE idempotency_key=$1`, [idem],
        );
        if (dup.rows[0]) {
          const d = dup.rows[0];
          if (d.kind !== 'boost' || d.post_id !== postId || d.amount !== amount || d.actor_email !== actor) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          const stakeRow = await c.query<{ stake: number }>('SELECT stake FROM posts WHERE id=$1', [postId]);
          return { ok: true as const, post_id: postId, new_stake: stakeRow.rows[0]?.stake ?? 0, action_id: d.id };
        }

        const postLock = await c.query<{ id: string; graveyard_at: Date | null }>(
          'SELECT id, graveyard_at FROM posts WHERE id=$1 FOR UPDATE', [postId],
        );
        if (!postLock.rows[0]) return { error: 'POST_NOT_FOUND' as const, message: 'no such post', status: 404 };
        if (postLock.rows[0].graveyard_at) return { error: 'POST_GRAVEYARDED' as const, message: 'post is in the graveyard', status: 410 };

        const lockSql = `SELECT id FROM tokens
          WHERE owner_email=$1 AND state='VALID'
          ORDER BY issued_at ASC
          LIMIT $2 FOR UPDATE SKIP LOCKED`;
        const { rows: locked } = await c.query<{ id: string }>(lockSql, [actor, amount]);
        if (locked.length < amount) return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };

        for (const t of locked) {
          await c.query(`UPDATE tokens SET state='BURNED', invalidated_at=now() WHERE id=$1`, [t.id]);
        }
        const actionId = randomUUID();
        await c.query(
          `INSERT INTO post_actions(id, post_id, actor_email, kind, amount, idempotency_key)
           VALUES($1,$2,$3,'boost',$4,$5)`,
          [actionId, postId, actor, amount, idem],
        );
        const upd = await c.query<{ stake: number }>(
          'UPDATE posts SET stake = stake + $1 WHERE id=$2 RETURNING stake', [amount, postId],
        );
        return { ok: true as const, post_id: postId, new_stake: upd.rows[0]!.stake, action_id: actionId };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        const { rows } = await app.pool.query<{ id: string; post_id: string; kind: string }>(
          'SELECT id, post_id, kind FROM post_actions WHERE idempotency_key=$1', [idem],
        );
        if (rows[0] && rows[0].kind === 'boost') {
          const stakeR = await app.pool.query<{ stake: number }>('SELECT stake FROM posts WHERE id=$1', [rows[0].post_id]);
          return reply.send({ ok: true, post_id: rows[0].post_id, new_stake: stakeR.rows[0]?.stake ?? 0, action_id: rows[0].id });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });

  app.post<{ Params: { id: string } }>('/post/:id/graveyard', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = GraveyardBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const postId = req.params.id;
    if (!UUID_RE.test(postId)) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid post id' });

    const actor = s.email;
    const idem = parsed.data.idempotency_key;

    type Result =
      | { ok: true; post_id: string; graveyard_stake: number; action_id: string }
      | { error: 'BAD_REQUEST' | 'INSUFFICIENT_BALANCE' | 'POST_NOT_FOUND' | 'POST_GRAVEYARDED'; message: string; status: number };

    let out!: Result;
    try {
      out = await withTx<Result>(app.pool, async (c) => {
        const dup = await c.query<{ id: string; post_id: string; amount: number; actor_email: string; kind: string }>(
          `SELECT id, post_id, amount, actor_email, kind FROM post_actions WHERE idempotency_key=$1`, [idem],
        );
        if (dup.rows[0]) {
          const d = dup.rows[0];
          if (d.kind !== 'graveyard' || d.post_id !== postId || d.actor_email !== actor) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return { ok: true as const, post_id: postId, graveyard_stake: d.amount, action_id: d.id };
        }

        const postLock = await c.query<{ id: string; stake: number; graveyard_at: Date | null }>(
          'SELECT id, stake, graveyard_at FROM posts WHERE id=$1 FOR UPDATE', [postId],
        );
        if (!postLock.rows[0]) return { error: 'POST_NOT_FOUND' as const, message: 'no such post', status: 404 };
        if (postLock.rows[0].graveyard_at) return { error: 'POST_GRAVEYARDED' as const, message: 'post is already in the graveyard', status: 410 };

        const cost = postLock.rows[0].stake * 2;
        const lockSql = `SELECT id FROM tokens
          WHERE owner_email=$1 AND state='VALID'
          ORDER BY issued_at ASC
          LIMIT $2 FOR UPDATE SKIP LOCKED`;
        const { rows: locked } = await c.query<{ id: string }>(lockSql, [actor, cost]);
        if (locked.length < cost) {
          return { error: 'INSUFFICIENT_BALANCE' as const, message: `need ${cost} RPOW to graveyard this post`, status: 400 };
        }

        for (const t of locked) {
          await c.query(`UPDATE tokens SET state='BURNED', invalidated_at=now() WHERE id=$1`, [t.id]);
        }
        const actionId = randomUUID();
        await c.query(
          `INSERT INTO post_actions(id, post_id, actor_email, kind, amount, idempotency_key)
           VALUES($1,$2,$3,'graveyard',$4,$5)`,
          [actionId, postId, actor, cost, idem],
        );
        // Wipe body and record the kill. Body is gone forever.
        await c.query(
          `UPDATE posts SET body = NULL, graveyard_at = now(), graveyard_by_email = $1,
                            graveyard_stake = $2
           WHERE id=$3`,
          [actor, cost, postId],
        );
        return { ok: true as const, post_id: postId, graveyard_stake: cost, action_id: actionId };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        const { rows } = await app.pool.query<{ id: string; post_id: string; amount: number; kind: string }>(
          'SELECT id, post_id, amount, kind FROM post_actions WHERE idempotency_key=$1', [idem],
        );
        if (rows[0] && rows[0].kind === 'graveyard') {
          return reply.send({ ok: true, post_id: rows[0].post_id, graveyard_stake: rows[0].amount, action_id: rows[0].id });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });

  app.get('/posts', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10) || 50));
    const params: unknown[] = [limit];
    // Active feed: hide graveyarded, sort by stake DESC then recency.
    const sql = `SELECT ${POST_COLS} FROM posts
                 WHERE graveyard_at IS NULL
                 ORDER BY stake DESC, created_at DESC
                 LIMIT $1`;
    const { rows } = await app.pool.query<PostRow>(sql, params);
    return rows.map(toSummary);
  });
}
