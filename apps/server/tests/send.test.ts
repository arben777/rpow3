import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';
import { randomUUID } from 'node:crypto';

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
  }
}

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}

describe('POST /send', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('transfers tokens between two registered users', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    const bCookie = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, aCookie, 3);

    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount: 2, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, transferred: 2, recipient_email: 'b@x.com' });

    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: bCookie } })).json();
    expect(aMe.balance).toBe(1);
    expect(bMe.balance).toBe(2);
  });

  it('creates a pending transfer when recipient has no account', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, aCookie, 1);
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'nobody@nowhere.com', amount: 1, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.pending).toBe(true);
    expect(body.transferred).toBe(1);
    expect(body.recipient_email).toBe('nobody@nowhere.com');
    // Sender's tokens are invalidated immediately; balance drops to 0.
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(0);
  });

  it('fails on insufficient balance', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects same idempotency_key with different parameters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await loginAs(ctx, 'c@x.com');
    await mineN(ctx, aCookie, 2);
    const key = randomUUID();
    const first = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    expect(first.statusCode).toBe(200);
    const conflict = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'c@x.com', amount: 1, idempotency_key: key } });
    expect(conflict.statusCode).toBe(409);
  });

  it('idempotency: same key returns same result', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await mineN(ctx, aCookie, 2);
    const key = randomUUID();
    const a = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    const b = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().transfer_id).toBe(b.json().transfer_id);
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(1); // only one token transferred, not two
  });
});
