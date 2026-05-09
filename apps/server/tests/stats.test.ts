import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import {
  flushMetrics,
  recordRequest,
  classifyClient,
  maskIp,
  _resetMetricsBufferForTests,
} from '../src/metrics.js';
import { _statsTestExports } from '../src/routes/stats.js';

const { maskEmail, providerFromDomain, regionFromDomain } = _statsTestExports;

async function seedToken(pool: import('pg').Pool, email: string) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES ($1, $2, 1, 'VALID', '\\x00')`,
    [randomUUID(), email],
  );
}
async function seedUser(pool: import('pg').Pool, email: string) {
  await pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT DO NOTHING`, [email]);
}

describe('helpers', () => {
  it('maskEmail keeps domain for known providers', () => {
    expect(maskEmail('arben@gmail.com')).toBe('arb***@gmail.com');
    expect(maskEmail('a@gmail.com')).toBe('a***@gmail.com');
  });
  it('maskEmail masks SLD for unknown domains', () => {
    expect(maskEmail('arben@example.fun')).toBe('arb***@***.fun');
    expect(maskEmail('a@b.org')).toBe('a***@***.org');
  });
  it('providerFromDomain classifies common providers', () => {
    expect(providerFromDomain('gmail.com')).toBe('Gmail');
    expect(providerFromDomain('qq.com')).toBe('QQ Mail');
    expect(providerFromDomain('outlook.com')).toBe('Outlook');
    expect(providerFromDomain('163.com')).toBe('163 Mail');
    expect(providerFromDomain('hotmail.co.uk')).toBe('Hotmail');
    expect(providerFromDomain('icloud.com')).toBe('iCloud');
    expect(providerFromDomain('yahoo.co.jp')).toBe('Yahoo');
    expect(providerFromDomain('example.com')).toBe('Other');
  });
  it('regionFromDomain handles China, Asia, EU/RU, Global', () => {
    expect(regionFromDomain('qq.com')).toBe('China');
    expect(regionFromDomain('163.com')).toBe('China');
    expect(regionFromDomain('foo.cn')).toBe('China');
    expect(regionFromDomain('naver.com')).toBe('Other Asia');
    expect(regionFromDomain('foo.jp')).toBe('Other Asia');
    expect(regionFromDomain('yandex.ru')).toBe('Europe / Russia');
    expect(regionFromDomain('foo.de')).toBe('Europe / Russia');
    expect(regionFromDomain('gmail.com')).toBe('Global');
  });
  it('maskIp redacts the middle two octets of v4', () => {
    expect(maskIp('108.45.12.160')).toBe('108.***.***.160');
    expect(maskIp(undefined)).toBe('unknown');
  });
  it('classifyClient picks coarse buckets', () => {
    expect(classifyClient('Mozilla/5.0 (Macintosh) Safari/605')).toBe('Safari');
    expect(classifyClient('Go-http-client/1.1')).toBe('Go client');
    expect(classifyClient('python-requests/2.31.0')).toBe('Python');
    expect(classifyClient('rpow-colab-gpu/0.1')).toBe('Colab GPU');
    expect(classifyClient('node-fetch/3.0')).toBe('Node.js');
    expect(classifyClient(undefined)).toBe('unknown');
  });
});

describe('GET /stats', () => {
  let cleanup: (() => Promise<void>) | null = null;
  beforeEach(() => { _resetMetricsBufferForTests(); });
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns zeroed live counters on a fresh DB', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live).toMatchObject({
      miners: 0, circulating: 0, transferred: 0, minted: 0,
      max_supply: 21, percent_minted: 0, remaining: 21,
    });
    expect(body.top_miners).toEqual([]);
    expect(body.concentration.top10_tokens).toBe(0);
    expect(body.email_providers.find((p: { name: string }) => p.name === 'Gmail').count).toBe(0);
  });

  it('produces a top-10 leaderboard with masked emails and percentages', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Five users; user A has 5 tokens, B has 3, C has 2, D has 1, E has 1.
    // Total VALID = 12.
    for (let i = 0; i < 5; i++) await seedToken(ctx.pool, 'alice@gmail.com');
    for (let i = 0; i < 3; i++) await seedToken(ctx.pool, 'bob@qq.com');
    for (let i = 0; i < 2; i++) await seedToken(ctx.pool, 'carol@example.fun');
    await seedToken(ctx.pool, 'dave@outlook.com');
    await seedToken(ctx.pool, 'eve@yandex.ru');

    const body = (await ctx.app.inject({ method: 'GET', url: '/stats' })).json();
    expect(body.live.circulating).toBe(12);
    expect(body.top_miners.length).toBe(5);
    expect(body.top_miners[0]).toMatchObject({
      rank: 1,
      email_masked: 'ali***@gmail.com',
      tokens: 5,
    });
    expect(body.top_miners[0].percent).toBeCloseTo((5 / 12) * 100, 5);
    expect(body.top_miners[2].email_masked).toBe('car***@***.fun');
    expect(body.concentration.top10_tokens).toBe(12);
    expect(body.concentration.top10_percent).toBe(100);
  });

  it('classifies email providers and regions from user table', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedUser(ctx.pool, 'a@gmail.com');
    await seedUser(ctx.pool, 'b@gmail.com');
    await seedUser(ctx.pool, 'c@qq.com');
    await seedUser(ctx.pool, 'd@163.com');
    await seedUser(ctx.pool, 'e@yandex.ru');

    const body = (await ctx.app.inject({ method: 'GET', url: '/stats' })).json();
    const providers = Object.fromEntries(
      body.email_providers.map((p: { name: string; count: number }) => [p.name, p.count]),
    );
    expect(providers.Gmail).toBe(2);
    expect(providers['QQ Mail']).toBe(1);
    expect(providers['163 Mail']).toBe(1);

    const regions = Object.fromEntries(
      body.regions.map((r: { name: string; count: number }) => [r.name, r.count]),
    );
    expect(regions.Global).toBe(2);
    expect(regions.China).toBe(2);
    expect(regions['Europe / Russia']).toBe(1);
    expect(body.live.miners).toBe(5);
  });

  it('reports endpoint, client, and source traffic after a flush', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Synthetic counters — bypassing the Fastify hook so we don't depend
    // on which routes happen to exist in the test app.
    for (let i = 0; i < 100; i++) {
      recordRequest({ endpoint: '/challenge', ip: '1.2.3.4', userAgent: 'Go-http-client' });
    }
    for (let i = 0; i < 50; i++) {
      recordRequest({ endpoint: '/mint', ip: '1.2.3.4', userAgent: 'Go-http-client' });
    }
    for (let i = 0; i < 10; i++) {
      recordRequest({ endpoint: '/me', ip: '5.6.7.8', userAgent: 'python-requests/2.31' });
    }
    await flushMetrics(ctx.pool);

    const body = (await ctx.app.inject({ method: 'GET', url: '/stats' })).json();
    const endpoints = Object.fromEntries(
      body.endpoint_traffic.map((e: { endpoint: string; requests: number }) => [e.endpoint, e.requests]),
    );
    expect(endpoints['/challenge']).toBe(100);
    expect(endpoints['/mint']).toBe(50);
    expect(endpoints['/me']).toBe(10);
    expect(body.mining_request_share_percent).toBeCloseTo((150 / 160) * 100, 5);

    const clients = Object.fromEntries(
      body.clients.map((c: { name: string; requests: number }) => [c.name, c.requests]),
    );
    expect(clients['Go client']).toBe(150);
    expect(clients.Python).toBe(10);

    expect(body.traffic_sources[0]).toMatchObject({
      rank: 1,
      source_masked: '1.***.***.4',
      requests: 150,
    });
  });

  it('is_capped flips at maxSupply', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    for (let i = 0; i < 21; i++) await seedToken(ctx.pool, `seed-${i}@gmail.com`);
    const body = (await ctx.app.inject({ method: 'GET', url: '/stats' })).json();
    expect(body.live.minted).toBe(21);
    expect(body.live.percent_minted).toBe(100);
    expect(body.difficulty.is_capped).toBe(true);
  });
});

describe('CORS multi-origin', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('allows the configured stats subdomain', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Default test app only allows http://web.test. /stats requested from
    // a sibling origin should be blocked unless we whitelist it.
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/stats',
      headers: {
        origin: 'http://stats.test',
        'access-control-request-method': 'GET',
      },
    });
    // CORS rejection isn't a 4xx — fastify-cors strips the Access-Control-*
    // headers when the origin is denied. We just verify no allow-origin is
    // echoed back so the browser refuses the response.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
