import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
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

describe('stats helpers', () => {
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

  describe('regionFromDomain', () => {
    it('classifies China', () => {
      expect(regionFromDomain('qq.com')).toBe('China');
      expect(regionFromDomain('163.com')).toBe('China');
      expect(regionFromDomain('foo.cn')).toBe('China');
    });
    it('classifies India / South Asia separately from Other Asia', () => {
      expect(regionFromDomain('foo.in')).toBe('India / South Asia');
      expect(regionFromDomain('foo.co.in')).toBe('India / South Asia');
      expect(regionFromDomain('foo.pk')).toBe('India / South Asia');
      expect(regionFromDomain('rediffmail.com')).toBe('India / South Asia');
    });
    it('classifies Other Asia', () => {
      expect(regionFromDomain('foo.jp')).toBe('Other Asia');
      expect(regionFromDomain('naver.com')).toBe('Other Asia');
      expect(regionFromDomain('foo.kr')).toBe('Other Asia');
      expect(regionFromDomain('yahoo.co.jp')).toBe('Other Asia');
    });
    it('classifies Russia / CIS', () => {
      expect(regionFromDomain('yandex.ru')).toBe('Russia / CIS');
      expect(regionFromDomain('foo.ua')).toBe('Russia / CIS');
      expect(regionFromDomain('foo.kz')).toBe('Russia / CIS');
    });
    it('classifies Europe', () => {
      expect(regionFromDomain('foo.de')).toBe('Europe');
      expect(regionFromDomain('foo.uk')).toBe('Europe');
      expect(regionFromDomain('foo.co.uk')).toBe('Europe');
      expect(regionFromDomain('gmx.de')).toBe('Europe');
    });
    it('classifies Middle East', () => {
      expect(regionFromDomain('foo.tr')).toBe('Middle East');
      expect(regionFromDomain('foo.sa')).toBe('Middle East');
      expect(regionFromDomain('foo.il')).toBe('Middle East');
    });
    it('classifies Latin America', () => {
      expect(regionFromDomain('foo.br')).toBe('Latin America');
      expect(regionFromDomain('foo.mx')).toBe('Latin America');
      expect(regionFromDomain('uol.com.br')).toBe('Latin America');
      expect(regionFromDomain('foo.co')).toBe('Latin America');
    });
    it('classifies Africa', () => {
      expect(regionFromDomain('foo.za')).toBe('Africa');
      expect(regionFromDomain('foo.ng')).toBe('Africa');
      expect(regionFromDomain('foo.eg')).toBe('Africa');
    });
    it('classifies Oceania', () => {
      expect(regionFromDomain('foo.au')).toBe('Oceania');
      expect(regionFromDomain('foo.nz')).toBe('Oceania');
    });
    it('classifies North America (.ca only)', () => {
      expect(regionFromDomain('foo.ca')).toBe('North America');
    });
    it('falls back to Generic providers for region-agnostic domains', () => {
      expect(regionFromDomain('gmail.com')).toBe('Generic providers');
      expect(regionFromDomain('outlook.com')).toBe('Generic providers');
      expect(regionFromDomain('icloud.com')).toBe('Generic providers');
    });
  });
});

describe('GET /stats', () => {
  let cleanup: (() => Promise<void>) | null = null;
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
    expect(body.regions).toEqual([]);
    expect(body.region_inferable_count).toBe(0);
    expect(body.region_inferable_percent).toBe(0);
    expect(body.email_providers.find((p: { name: string }) => p.name === 'Gmail').count).toBe(0);
    // Removed sections should not be present in the response shape.
    expect(body.clients).toBeUndefined();
    expect(body.traffic_sources).toBeUndefined();
    expect(body.endpoint_traffic).toBeUndefined();
  });

  it('produces a top-10 leaderboard with masked emails and percentages', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
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

  it('classifies email providers and regions, drops empty buckets, pins Generic last', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedUser(ctx.pool, 'a@gmail.com');
    await seedUser(ctx.pool, 'b@gmail.com');
    await seedUser(ctx.pool, 'c@qq.com');
    await seedUser(ctx.pool, 'd@163.com');
    await seedUser(ctx.pool, 'e@yandex.ru');
    await seedUser(ctx.pool, 'f@foo.br');
    await seedUser(ctx.pool, 'g@foo.in');

    const body = (await ctx.app.inject({ method: 'GET', url: '/stats' })).json();
    const providers = Object.fromEntries(
      body.email_providers.map((p: { name: string; count: number }) => [p.name, p.count]),
    );
    expect(providers.Gmail).toBe(2);
    expect(providers['QQ Mail']).toBe(1);
    expect(providers['163 Mail']).toBe(1);

    const regionNames = body.regions.map((r: { name: string }) => r.name);
    // Only buckets with users show up — no Africa/Oceania/Middle East/Europe/etc. zero rows.
    expect(regionNames).toEqual([
      'China', 'India / South Asia', 'Russia / CIS', 'Latin America', 'Generic providers',
    ]);
    // China = 2 (qq.com + 163.com); India = 1; Russia = 1; LATAM = 1; Generic = 2 (gmail).
    const regionCounts = Object.fromEntries(
      body.regions.map((r: { name: string; count: number }) => [r.name, r.count]),
    );
    expect(regionCounts.China).toBe(2);
    expect(regionCounts['India / South Asia']).toBe(1);
    expect(regionCounts['Generic providers']).toBe(2);
    // 5 of 7 users have an inferable region.
    expect(body.region_inferable_count).toBe(5);
    expect(body.region_inferable_percent).toBeCloseTo((5 / 7) * 100, 5);
    expect(body.live.miners).toBe(7);
  });

  it('omits the Generic providers row when no generic-provider users exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedUser(ctx.pool, 'a@foo.cn');
    await seedUser(ctx.pool, 'b@foo.de');
    const body = (await ctx.app.inject({ method: 'GET', url: '/stats' })).json();
    const names = body.regions.map((r: { name: string }) => r.name);
    expect(names).not.toContain('Generic providers');
    expect(body.region_inferable_percent).toBe(100);
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

  it('rejects an origin that is not in the allow-list', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/stats',
      headers: {
        origin: 'http://stats.test',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
