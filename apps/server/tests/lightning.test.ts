import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({
    method: 'POST', url: '/auth/request',
    payload: { email }, headers: { 'content-type': 'application/json' },
  });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}

describe('lightning routes', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('GET /ln/balance returns LIGHTNING_DISABLED when not enabled? Actually returns balance with enabled=false', async () => {
    // /ln/balance is intentionally always-on (read-only); only mutations
    // are disabled when LIGHTNING_ENABLED=false. The balance endpoint
    // surfaces enabled=false so the front-end can show the right UI.
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'a@x.com');
    const r = await ctx.app.inject({ method: 'GET', url: '/ln/balance', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.balance_msat).toBe(0);
    expect(body.ln_address).toMatch(/^[a-z0-9]+@test\.local$/);
    expect(body.enabled).toBe(false);
    expect(body.ln_address_renamed).toBe(false);
  });

  it('POST /ln/redeem returns LIGHTNING_DISABLED when not enabled', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'a@x.com');
    const r = await ctx.app.inject({
      method: 'POST', url: '/ln/redeem',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { destination: 'foo@bar.com', amount_msat: 1_000_000 },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('LIGHTNING_DISABLED');
  });

  it('rename: one rename per account', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'a@x.com');
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/ln/rename',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { handle: 'alice' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().handle).toBe('alice');
    expect(r1.json().ln_address).toBe('alice@test.local');

    const r2 = await ctx.app.inject({
      method: 'POST', url: '/ln/rename',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { handle: 'alice2' },
    });
    expect(r2.statusCode).toBe(409);
  });

  it('GET /.well-known/lnurlp/:handle returns payRequest after balance row exists', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'a@x.com');
    // Force a balance row to be created.
    await ctx.app.inject({ method: 'GET', url: '/ln/balance', headers: { cookie } });
    const handle = (await ctx.pool.query<{ ln_address_handle: string }>(
      `SELECT ln_address_handle FROM ln_user_balances WHERE user_email='a@x.com'`,
    )).rows[0]!.ln_address_handle;

    const r = await ctx.app.inject({ method: 'GET', url: `/.well-known/lnurlp/${handle}` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.tag).toBe('payRequest');
    expect(body.callback).toContain(`/lnurl/${handle}/callback`);
    expect(body.minSendable).toBe(1000);
  });

  it('GET /.well-known/lnurlp/:handle returns 404 for unknown handle', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/.well-known/lnurlp/nope' });
    expect(r.statusCode).toBe(404);
  });
});
