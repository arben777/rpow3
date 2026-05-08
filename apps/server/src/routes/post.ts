import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';

// Hashcash-as-stamps. POST /post burns one VALID token and inserts a public
// post in the same transaction. The wall feed (GET /posts) is public — the
// audit chain (post → token_id → mint event) is the whole point.

const PostBody = z.object({
  body: z.string().min(1).max(280),
  idempotency_key: z.string().min(8).max(80),
});

// Strip ASCII control characters except newline (0x0A) and tab (0x09).
// Preserves user newlines without letting NULs or escape sequences through.
function sanitize(s: string): string {
  return s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
}

interface PostRow {
  id: string;
  author_email: string;
  body: string;
  token_id: string;
  created_at: Date;
}

function toSummary(r: PostRow) {
  return {
    id: r.id,
    author_email: r.author_email,
    body: r.body,
    token_id: r.token_id,
    created_at: r.created_at.toISOString(),
  };
}

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
          'SELECT id, author_email, body, token_id, created_at FROM posts WHERE idempotency_key=$1', [idem],
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
        const ins = await c.query<{ created_at: Date }>(
          `INSERT INTO posts(id, author_email, token_id, body, idempotency_key)
           VALUES($1,$2,$3,$4,$5) RETURNING created_at`,
          [postId, author, tokenId, body, idem],
        );
        return {
          ok: true as const,
          post: toSummary({ id: postId, author_email: author, body, token_id: tokenId, created_at: ins.rows[0]!.created_at }),
        };
      });
    } catch (e: any) {
      // Concurrent retry of the same idempotency_key may race past the SELECT
      // and trip the UNIQUE constraint. Re-read and return the canonical row.
      if (e?.code === '23505') {
        const { rows } = await app.pool.query<PostRow>(
          'SELECT id, author_email, body, token_id, created_at FROM posts WHERE idempotency_key=$1', [idem],
        );
        if (rows[0]) return reply.send({ ok: true, post: toSummary(rows[0]) });
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });

  app.get('/posts', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10) || 50));
    const params: unknown[] = [];
    let where = '';
    if (q.before) {
      const d = new Date(q.before);
      if (isNaN(d.getTime())) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid before' });
      params.push(d);
      where = `WHERE created_at < $${params.length}`;
    }
    params.push(limit);
    const sql = `SELECT id, author_email, token_id, body, created_at
                 FROM posts ${where}
                 ORDER BY created_at DESC
                 LIMIT $${params.length}`;
    const { rows } = await app.pool.query<PostRow>(sql, params);
    return rows.map(toSummary);
  });
}
