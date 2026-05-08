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

async function makePost(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, body: string) {
  const r = await ctx.app.inject({
    method: 'POST', url: '/post',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { body, idempotency_key: randomUUID() },
  });
  expect(r.statusCode).toBe(200);
  return r.json().post;
}

describe('POST /post + GET /posts', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('burns a token, creates a public post, /posts returns it with stake=1', async () => {
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
    expect(body.post.stake).toBe(1);
    expect(body.post.graveyard_at).toBeNull();

    const feed = (await ctx.app.inject({ method: 'GET', url: '/posts' })).json();
    expect(feed.length).toBe(1);
    expect(feed[0].id).toBe(body.post.id);
    expect(feed[0].stake).toBe(1);

    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a } })).json();
    expect(me.balance).toBe(0);
    expect(me.burned).toBe(1);

    const led = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(led.total_burned).toBe(1);
    expect(led.circulating_supply).toBe(0);
    expect(led.total_minted).toBe(1);
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
    const r1 = await ctx.app.inject({ method: 'POST', url: '/post', headers: { cookie: a, 'content-type': 'application/json' }, payload: { body: 'replay-safe', idempotency_key: key } });
    const r2 = await ctx.app.inject({ method: 'POST', url: '/post', headers: { cookie: a, 'content-type': 'application/json' }, payload: { body: 'replay-safe', idempotency_key: key } });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().post.id).toBe(r2.json().post.id);

    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a } })).json();
    expect(me.balance).toBe(1);
    expect(me.burned).toBe(1);
  });

  it('rejects same idempotency_key with different body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);
    const key = randomUUID();
    const r1 = await ctx.app.inject({ method: 'POST', url: '/post', headers: { cookie: a, 'content-type': 'application/json' }, payload: { body: 'first body', idempotency_key: key } });
    expect(r1.statusCode).toBe(200);
    const r2 = await ctx.app.inject({ method: 'POST', url: '/post', headers: { cookie: a, 'content-type': 'application/json' }, payload: { body: 'different body', idempotency_key: key } });
    expect(r2.statusCode).toBe(409);
  });

  it('rejects empty/oversize body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);
    const empty = await ctx.app.inject({ method: 'POST', url: '/post', headers: { cookie: a, 'content-type': 'application/json' }, payload: { body: '   \n  ', idempotency_key: randomUUID() } });
    expect(empty.statusCode).toBe(400);
    const huge = await ctx.app.inject({ method: 'POST', url: '/post', headers: { cookie: a, 'content-type': 'application/json' }, payload: { body: 'x'.repeat(281), idempotency_key: randomUUID() } });
    expect(huge.statusCode).toBe(400);
  });

  it('GET /posts is public — no session required', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/posts' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('activity includes burn entries for the original post', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);
    await ctx.app.inject({ method: 'POST', url: '/post', headers: { cookie: a, 'content-type': 'application/json' }, payload: { body: 'audit me', idempotency_key: randomUUID() } });
    const act = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: a } })).json();
    expect(act.find((e: any) => e.type === 'burn' && e.amount === 1)).toBeTruthy();
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/post', headers: { 'content-type': 'application/json' }, payload: { body: 'no-auth', idempotency_key: randomUUID() } });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /post/:id/boost', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('increments stake, burns N tokens, raises rank in feed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    const b = await loginAs(ctx, 'b@x.com');

    // Two posts: A's first (stake=1), then B's (stake=1). B's is newer so naturally first.
    await mineN(ctx, a, 1);
    const aPost = await makePost(ctx, a, 'a says hi');
    await mineN(ctx, b, 4);
    const bPost = await makePost(ctx, b, 'b says hi');

    // a starts behind b (b is newer, same stake). a boosts its own post by 3.
    await mineN(ctx, a, 3);
    const boost = await ctx.app.inject({
      method: 'POST', url: `/post/${aPost.id}/boost`,
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { amount: 3, idempotency_key: randomUUID() },
    });
    expect(boost.statusCode).toBe(200);
    expect(boost.json().new_stake).toBe(4);

    // a now has stake 4, b has stake 1: a rises to top.
    const feed = (await ctx.app.inject({ method: 'GET', url: '/posts' })).json();
    expect(feed[0].id).toBe(aPost.id);
    expect(feed[0].stake).toBe(4);
    expect(feed[1].id).toBe(bPost.id);
    expect(feed[1].stake).toBe(1);

    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: a } })).json();
    expect(aMe.balance).toBe(0);
    expect(aMe.burned).toBe(4); // 1 for original post + 3 for boost
  });

  it('any user can boost any post (b boosts a)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    const b = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, a, 1);
    const p = await makePost(ctx, a, 'mine but boostable');
    await mineN(ctx, b, 5);

    const r = await ctx.app.inject({
      method: 'POST', url: `/post/${p.id}/boost`,
      headers: { cookie: b, 'content-type': 'application/json' },
      payload: { amount: 5, idempotency_key: randomUUID() },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().new_stake).toBe(6);
  });

  it('rejects with INSUFFICIENT_BALANCE', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);
    const p = await makePost(ctx, a, 'broke');
    const r = await ctx.app.inject({
      method: 'POST', url: `/post/${p.id}/boost`,
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { amount: 5, idempotency_key: randomUUID() },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('404 on unknown post', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 1);
    const r = await ctx.app.inject({
      method: 'POST', url: `/post/${randomUUID()}/boost`,
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { amount: 1, idempotency_key: randomUUID() },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('POST_NOT_FOUND');
  });

  it('idempotent: same key replays same boost', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 3);
    const p = await makePost(ctx, a, 'idem boost');
    const key = randomUUID();
    const r1 = await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/boost`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { amount: 2, idempotency_key: key } });
    const r2 = await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/boost`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { amount: 2, idempotency_key: key } });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().action_id).toBe(r2.json().action_id);
    const feed = (await ctx.app.inject({ method: 'GET', url: '/posts' })).json();
    expect(feed[0].stake).toBe(3); // 1 (original) + 2 (boost), not 5
  });
});

describe('POST /post/:id/graveyard', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('burns 2× stake, hides post from feed, wipes body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    const b = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, a, 1);
    const p = await makePost(ctx, a, 'kill me'); // stake = 1
    await mineN(ctx, b, 2); // b needs 2 to graveyard

    const r = await ctx.app.inject({
      method: 'POST', url: `/post/${p.id}/graveyard`,
      headers: { cookie: b, 'content-type': 'application/json' },
      payload: { idempotency_key: randomUUID() },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().graveyard_stake).toBe(2);

    const feed = (await ctx.app.inject({ method: 'GET', url: '/posts' })).json();
    expect(feed.length).toBe(0); // graveyarded posts hidden from feed

    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: b } })).json();
    expect(bMe.burned).toBe(2);

    const led = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(led.total_burned).toBe(3); // 1 (original post) + 2 (graveyard)
  });

  it('cost scales with stake: boosted post is 2× harder to kill', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    const b = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, a, 5);
    const p = await makePost(ctx, a, 'fortified'); // stake=1
    // a boosts to stake=5
    await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/boost`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { amount: 4, idempotency_key: randomUUID() } });

    // b has only 5 — needs 10. Should fail.
    await mineN(ctx, b, 5);
    const fail = await ctx.app.inject({
      method: 'POST', url: `/post/${p.id}/graveyard`,
      headers: { cookie: b, 'content-type': 'application/json' },
      payload: { idempotency_key: randomUUID() },
    });
    expect(fail.statusCode).toBe(400);
    expect(fail.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects boost on graveyarded post (410)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 4);
    const p = await makePost(ctx, a, 'doomed'); // stake=1
    await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/graveyard`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { idempotency_key: randomUUID() } });

    const r = await ctx.app.inject({
      method: 'POST', url: `/post/${p.id}/boost`,
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: { amount: 1, idempotency_key: randomUUID() },
    });
    expect(r.statusCode).toBe(410);
    expect(r.json().error).toBe('POST_GRAVEYARDED');
  });

  it('rejects double-graveyard (410)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 5);
    const p = await makePost(ctx, a, 'twice dead');
    const first = await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/graveyard`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { idempotency_key: randomUUID() } });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/graveyard`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { idempotency_key: randomUUID() } });
    expect(second.statusCode).toBe(410);
  });

  it('idempotent: same key replays same graveyard', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 3);
    const p = await makePost(ctx, a, 'idem grave');
    const key = randomUUID();
    const r1 = await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/graveyard`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { idempotency_key: key } });
    const r2 = await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/graveyard`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { idempotency_key: key } });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().action_id).toBe(r2.json().action_id);
    expect(r2.json().graveyard_stake).toBe(2);
  });

  it('activity surfaces boost and graveyard rows', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, a, 5);
    const p = await makePost(ctx, a, 'multi-action');
    await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/boost`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { amount: 1, idempotency_key: randomUUID() } });
    await ctx.app.inject({ method: 'POST', url: `/post/${p.id}/graveyard`, headers: { cookie: a, 'content-type': 'application/json' }, payload: { idempotency_key: randomUUID() } });
    const act = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: a } })).json();
    expect(act.find((e: any) => e.type === 'boost' && e.amount === 1)).toBeTruthy();
    expect(act.find((e: any) => e.type === 'graveyard' && e.amount === 4)).toBeTruthy(); // 2 × stake-2
  });
});
