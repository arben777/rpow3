import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';
import { randomUUID } from 'node:crypto';

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
  }
}

describe('POST /post + GET /posts', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('burns a token, creates a public post, /posts returns it', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);

    const res = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: 'hello, wall.', idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.post.author_email).toBe('a@x.com');
    expect(body.post.body).toBe('hello, wall.');
    expect(typeof body.post.id).toBe('string');
    expect(typeof body.post.token_id).toBe('string');

    // /posts is public, returns the post
    const feed = (await ctx.app.inject({ method: 'GET', url: '/posts' })).json();
    expect(Array.isArray(feed)).toBe(true);
    expect(feed.length).toBe(1);
    expect(feed[0].id).toBe(body.post.id);
    expect(feed[0].body).toBe('hello, wall.');

    // Balance dropped to 0; burned counter is 1
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a } })).json();
    expect(me.balance).toBe(0);
    expect(me.burned).toBe(1);

    // Ledger reflects the burn
    const led = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(led.total_burned).toBe(1);
    expect(led.circulating_supply).toBe(0);
    expect(led.total_minted).toBe(1); // mint slot still consumed
  });

  it('rejects with INSUFFICIENT_BALANCE when wallet is empty', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: 'too poor to post', idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('idempotency: same key returns same post and only burns once', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 2);

    const key = randomUUID();
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: 'replay-safe', idempotency_key: key },
    });
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: 'replay-safe', idempotency_key: key },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().post.id).toBe(r2.json().post.id);

    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a } })).json();
    expect(me.balance).toBe(1); // only one token burned, not two
    expect(me.burned).toBe(1);
  });

  it('rejects same idempotency_key with different body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);
    const key = randomUUID();
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: 'first body', idempotency_key: key },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: 'different body', idempotency_key: key },
    });
    expect(r2.statusCode).toBe(409);
  });

  it('rejects empty/oversize body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);
    const empty = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: '   \n  ', idempotency_key: randomUUID() },
    });
    expect(empty.statusCode).toBe(400);
    const huge = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: 'x'.repeat(281), idempotency_key: randomUUID() },
    });
    expect(huge.statusCode).toBe(400);
  });

  it('GET /posts is public — no session required', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/posts' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('activity includes burn entries', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);
    await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { body: 'audit me', idempotency_key: randomUUID() },
    });
    const act = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: a } })).json();
    expect(act.find((e: any) => e.type === 'burn' && e.amount === 1)).toBeTruthy();
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/post',
      headers: { 'content-type': 'application/json' },
      payload: { body: 'no-auth', idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });
});
