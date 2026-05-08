import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /ledger — growth + doubling', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('user_growth is empty and doubling_seconds + first_signup_at are null with no users', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.user_growth).toEqual([]);
    expect(body.doubling_seconds).toBeNull();
    expect(body.first_signup_at).toBeNull();
  });

  it('first_signup_at matches the earliest user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(
      `INSERT INTO users(email, created_at) VALUES
        ('a@x.com', '2026-05-08 21:22:00+00'),
        ('b@x.com', '2026-05-08 23:00:00+00'),
        ('c@x.com', '2026-05-09 00:30:00+00')`,
    );
    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.first_signup_at).toBe('2026-05-08T21:22:00.000Z');
  });

  it('user_growth uses 5-minute bins (denser than hourly)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Three users in a single hour but in three different 5-minute bins.
    await ctx.pool.query(
      `INSERT INTO users(email, created_at) VALUES
        ('a@x.com', '2026-05-08 21:02:00+00'),
        ('b@x.com', '2026-05-08 21:18:00+00'),
        ('c@x.com', '2026-05-08 21:42:00+00')`,
    );
    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.user_growth.length).toBe(3); // three distinct 5-min buckets
    const last = body.user_growth[body.user_growth.length - 1];
    expect(last.users).toBe(3);
  });

  it('doubling_seconds null when only one user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, created_at) VALUES('a@x.com', now())`);
    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.user_count).toBe(1);
    expect(body.user_growth.length).toBeGreaterThanOrEqual(1);
    expect(body.doubling_seconds).toBeNull();
  });

  it('reports a positive doubling_seconds when N >= 2', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Seed 4 users with backdated timestamps spaced by 1 hour.
    // Doubling should pick offset floor((4-1)/2) = 1 → user #2 (created 3h ago).
    await ctx.pool.query(
      `INSERT INTO users(email, created_at) VALUES
        ('u1@x.com', now() - interval '4 hour'),
        ('u2@x.com', now() - interval '3 hour'),
        ('u3@x.com', now() - interval '2 hour'),
        ('u4@x.com', now() - interval '1 hour')`,
    );
    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.user_count).toBe(4);
    expect(body.doubling_seconds).not.toBeNull();
    // ~3h ± slop. Allow a wide window for CI clock variance.
    expect(body.doubling_seconds).toBeGreaterThan(60 * 60 * 2.5);
    expect(body.doubling_seconds).toBeLessThan(60 * 60 * 3.5);
  });

  it('user_growth is monotonic and bucketed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(
      `INSERT INTO users(email, created_at) VALUES
        ('u1@x.com', now() - interval '3 hour'),
        ('u2@x.com', now() - interval '2 hour'),
        ('u3@x.com', now() - interval '2 hour'),
        ('u4@x.com', now() - interval '1 hour')`,
    );
    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    const users = body.user_growth.map((p: { users: number }) => p.users);
    // Cumulative: monotonically non-decreasing.
    for (let i = 1; i < users.length; i++) {
      expect(users[i]).toBeGreaterThanOrEqual(users[i - 1]);
    }
    expect(users[users.length - 1]).toBe(4);
  });
});
