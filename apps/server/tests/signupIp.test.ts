import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function magicLinkAndVerify(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  email: string,
  ip: string,
): Promise<void> {
  // The makeTestApp instance has trustProxy=true, so X-Forwarded-For sets req.ip.
  await ctx.app.inject({
    method: 'POST', url: '/auth/request',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    payload: { email },
  });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  await ctx.app.inject({
    method: 'GET', url: `/auth/verify?token=${tok}`,
    headers: { 'x-forwarded-for': ip },
  });
}

describe('user_signup_ips', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('records the IP on first /auth/verify and stops there', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await magicLinkAndVerify(ctx, 'a@x.com', '203.0.113.7');

    const r = await ctx.pool.query<{ ip_addr: string }>(
      'SELECT ip_addr FROM user_signup_ips WHERE email=$1', ['a@x.com'],
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.ip_addr).toBe('203.0.113.7');
  });

  it('first IP wins — later logins do not overwrite', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await magicLinkAndVerify(ctx, 'a@x.com', '203.0.113.7');
    await magicLinkAndVerify(ctx, 'a@x.com', '198.51.100.42');

    const r = await ctx.pool.query<{ ip_addr: string }>(
      'SELECT ip_addr FROM user_signup_ips WHERE email=$1', ['a@x.com'],
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.ip_addr).toBe('203.0.113.7');
  });

  it('does not break /auth/verify if the user already has a row (idempotent)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('a@x.com')`);
    await ctx.pool.query(
      `INSERT INTO user_signup_ips(email, ip_addr) VALUES('a@x.com', '10.0.0.1')`,
    );
    // /auth/verify on this existing user should still succeed and not crash on the
    // duplicate-key path.
    await magicLinkAndVerify(ctx, 'a@x.com', '203.0.113.7');

    const r = await ctx.pool.query<{ ip_addr: string }>(
      'SELECT ip_addr FROM user_signup_ips WHERE email=$1', ['a@x.com'],
    );
    expect(r.rows[0]!.ip_addr).toBe('10.0.0.1');
  });

  it('pre-existing users (no row) keep working — login simply backfills the IP', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Simulate a user that existed before this migration: row in users, none in user_signup_ips.
    await ctx.pool.query(`INSERT INTO users(email) VALUES('legacy@x.com')`);

    await magicLinkAndVerify(ctx, 'legacy@x.com', '198.51.100.10');

    const r = await ctx.pool.query<{ ip_addr: string }>(
      'SELECT ip_addr FROM user_signup_ips WHERE email=$1', ['legacy@x.com'],
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.ip_addr).toBe('198.51.100.10');
  });
});
