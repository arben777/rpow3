import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

async function loginAndChallenge(ctx: Awaited<ReturnType<typeof makeTestApp>>) {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'a@b.com' }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  const cookie = r.headers['set-cookie'] as string;
  const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
  return { cookie, ch };
}

describe('POST /mint', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('credits a token on a valid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token.value).toBe(1);
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.balance).toBe(1);
    expect(me.minted).toBe(1);
  });

  it('rejects invalid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: '0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SOLUTION');
  });

  it('rejects double-claim of same challenge', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const first = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('CHALLENGE_ALREADY_CLAIMED');
  });

  async function seedRootTokens(ctx: Awaited<ReturnType<typeof makeTestApp>>, n: number, ownerPrefix = 'seed') {
    const { randomUUID } = await import('node:crypto');
    for (let i = 0; i < n; i++) {
      await ctx.pool.query(
        `INSERT INTO tokens(id, owner_email, value, state, server_sig)
         VALUES ($1, $2, 1, 'VALID', '\\x00')`,
        [randomUUID(), `${ownerPrefix}-${i}@x.com`],
      );
    }
    // Direct inserts bypass /mint, so the maintained supply counter (migration
    // 005) doesn't auto-increment. Sync it here so cap-boundary tests see the
    // expected supply.
    await ctx.pool.query(
      `UPDATE app_counters SET value = value + $1 WHERE name='minted_supply'`,
      [n],
    );
  }

  it('refuses with 410 SUPPLY_EXHAUSTED when cap is reached between challenge and mint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    // Challenge was issued at supply=0 with difficulty 8. Now race the cap by
    // seeding directly to maxSupply (21).
    await seedRootTokens(ctx, 21);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('SUPPLY_EXHAUSTED');
  });

  it('serializes concurrent mints at the cap boundary so only one succeeds', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Pre-seed to supply=20. Cap is 21. We'll issue 5 challenges across 5 users
    // and fire 5 mints in parallel; exactly 1 should succeed.
    await seedRootTokens(ctx, 20, 'pad');

    const cookies: string[] = [];
    const challenges: Array<{ challenge_id: string; nonce_prefix: string; difficulty_bits: number }> = [];
    for (let i = 0; i < 5; i++) {
      const email = `racer-${i}@x.com`;
      await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
      const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
      const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
      const cookie = r.headers['set-cookie'] as string;
      cookies.push(cookie);
      const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
      challenges.push(ch);
    }

    // Pre-mine all 5 nonces (supply was 20 when each challenge issued, so all 5
    // were stamped at the same difficulty. They're all valid solutions.)
    const nonces = challenges.map(ch =>
      findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits)
    );

    const results = await Promise.all(
      challenges.map((ch, i) =>
        ctx.app.inject({
          method: 'POST', url: '/mint',
          headers: { cookie: cookies[i], 'content-type': 'application/json' },
          payload: { challenge_id: ch.challenge_id, solution_nonce: nonces[i].toString() },
        }),
      ),
    );

    const successes = results.filter(r => r.statusCode === 200);
    const exhausted = results.filter(r => r.statusCode === 410 && r.json().error === 'SUPPLY_EXHAUSTED');
    expect(successes.length).toBe(1);
    expect(exhausted.length).toBe(4);
  });
});
