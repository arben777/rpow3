import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { issueMagicLink } from '../magic.js';

const RequestBody = z.object({ email: z.string().email() });

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/request', async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid email' });
    const email = parsed.data.email.toLowerCase().trim();

    const { token, hash } = issueMagicLink();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await app.pool.query(
      'INSERT INTO magic_links(id, email, token_hash, expires_at) VALUES($1,$2,$3,$4)',
      [id, email, hash, expiresAt],
    );

    const link = `${app.config.magicLinkBaseUrl}/auth/verify?token=${token}`;
    await app.mailer.send({
      to: email,
      subject: 'rpow2 — your magic link',
      text: `Click to sign in:\n${link}\n\nLink expires in 15 minutes.`,
      html: `<p>Click to sign in to <a href="${link}">rpow2</a>.</p><p><a href="${link}">${link}</a></p><p>Link expires in 15 minutes.</p>`,
    });

    return { ok: true, cooldown_seconds: 30 };
  });
}
