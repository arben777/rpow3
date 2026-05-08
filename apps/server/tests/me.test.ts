import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const res = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  return res.headers['set-cookie'] as string;
}

describe('GET /me', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns email + zero balances on first login', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'a@b.com', balance: 0, minted: 0, sent: 0, received: 0, burned: 0 });
  });
});
