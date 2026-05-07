import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('POST /auth/request', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('emails a magic link and stores a hashed token', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/auth/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'frk314@gmail.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.mailer.outbox).toHaveLength(1);
    expect(ctx.mailer.outbox[0]!.to).toBe('frk314@gmail.com');
    expect(ctx.mailer.outbox[0]!.html).toMatch(/http:\/\/test\/auth\/verify\?token=/);
    const { rowCount } = await ctx.pool.query('SELECT 1 FROM magic_links WHERE email=$1', ['frk314@gmail.com']);
    expect(rowCount).toBe(1);
  });

  it('rejects malformed email', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/auth/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });
});
