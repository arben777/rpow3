import type { FastifyInstance } from 'fastify';
import { difficultyForSupply, epochInfo } from '../schedule.js';

/**
 * Public /stats endpoint — drives the stats.rpow3.com dashboard.
 *
 * Aggregates network-wide counters, miner leaderboards, supply
 * concentration, derived demographic breakdowns from email domains, and
 * the request-metrics table populated by the onResponse hook.
 *
 * Cached 60 s and coalesced behind a single in-flight promise. The
 * heaviest query (top miners + per-miner totals) does a full GROUP BY on
 * tokens, which we don't want firing per-poller. 60 s of staleness is
 * invisible on a stats page.
 */
const STATS_CACHE_MS = 60_000;

const KNOWN_PROVIDER_DOMAINS = new Set<string>([
  'gmail.com', 'googlemail.com',
  'qq.com', 'foxmail.com',
  'outlook.com', 'live.com', 'msn.com',
  '163.com', '126.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr',
  'icloud.com', 'me.com', 'mac.com',
  'yahoo.com', 'ymail.com', 'yahoo.co.uk', 'yahoo.co.jp',
  'protonmail.com', 'proton.me',
  'aol.com', 'fastmail.com',
]);

function maskEmail(email: string): string {
  const idx = email.lastIndexOf('@');
  if (idx <= 0) return email;
  const local = email.slice(0, idx);
  const domain = email.slice(idx + 1).toLowerCase();
  const head = local.slice(0, 3);
  const localMasked = `${head}***`;
  if (KNOWN_PROVIDER_DOMAINS.has(domain)) {
    return `${localMasked}@${domain}`;
  }
  // Unknown domain — keep the TLD, mask the rest.
  const dot = domain.lastIndexOf('.');
  if (dot <= 0) return `${localMasked}@***`;
  return `${localMasked}@***${domain.slice(dot)}`;
}

function providerFromDomain(domain: string): string {
  const d = domain.toLowerCase();
  if (d === 'gmail.com' || d === 'googlemail.com') return 'Gmail';
  if (d === 'qq.com' || d === 'foxmail.com') return 'QQ Mail';
  if (d === 'outlook.com' || d === 'live.com' || d === 'msn.com') return 'Outlook';
  if (d === '163.com' || d === '126.com') return '163 Mail';
  if (d.startsWith('hotmail.')) return 'Hotmail';
  if (d === 'icloud.com' || d === 'me.com' || d === 'mac.com') return 'iCloud';
  if (d === 'yahoo.com' || d === 'ymail.com' || d.startsWith('yahoo.')) return 'Yahoo';
  return 'Other';
}

function regionFromDomain(domain: string): string {
  const d = domain.toLowerCase();
  if (
    d.endsWith('.cn')
    || d === 'qq.com' || d === 'foxmail.com'
    || d === '163.com' || d === '126.com'
    || d === 'sina.com' || d === 'sohu.com' || d === 'aliyun.com'
  ) return 'China';
  if (
    d.endsWith('.jp') || d.endsWith('.kr') || d.endsWith('.tw') || d.endsWith('.hk')
    || d.endsWith('.sg') || d.endsWith('.my') || d.endsWith('.id') || d.endsWith('.th')
    || d.endsWith('.vn') || d.endsWith('.ph') || d.endsWith('.in')
    || d === 'naver.com' || d === 'daum.net'
  ) return 'Other Asia';
  if (
    d.endsWith('.ru') || d.endsWith('.de') || d.endsWith('.fr') || d.endsWith('.uk')
    || d.endsWith('.it') || d.endsWith('.es') || d.endsWith('.nl') || d.endsWith('.pl')
    || d.endsWith('.se') || d.endsWith('.fi') || d.endsWith('.no') || d.endsWith('.dk')
    || d.endsWith('.cz') || d.endsWith('.gr') || d.endsWith('.ua') || d.endsWith('.by')
    || d.endsWith('.eu')
    || d === 'yandex.ru' || d === 'mail.ru' || d === 'rambler.ru'
    || d === 'gmx.de' || d === 'web.de' || d === 't-online.de'
    || d === 'orange.fr' || d === 'wanadoo.fr'
  ) return 'Europe / Russia';
  return 'Global';
}

const PROVIDER_ORDER = ['Gmail', 'QQ Mail', 'Outlook', '163 Mail', 'Hotmail', 'iCloud', 'Yahoo', 'Other'] as const;
const REGION_ORDER = ['Global', 'China', 'Other Asia', 'Europe / Russia'] as const;

export async function statsRoutes(app: FastifyInstance) {
  let cached: { ts: number; body: unknown } | null = null;
  let inflight: Promise<unknown> | null = null;

  async function refresh() {
    const [
      { rows: minted },
      { rows: transferred },
      { rows: circ },
      { rows: users },
      { rows: topRows },
      { rows: top10Rows },
      { rows: top30Rows },
      { rows: domainRows },
      { rows: endpointRows },
      { rows: clientRows },
      { rows: sourceRows },
    ] = await Promise.all([
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL`),
      app.pool.query<{ n: number }>(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE state='VALID'`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`),
      // Top 30 miners by tokens currently held — VALID supply, not lifetime
      // mints. Mirrors what wallet pages show. We materialize 30 rows so
      // we can also derive the top10/top30 supply share without a second pass.
      app.pool.query<{ owner: string; tokens: number }>(`
        SELECT owner_email AS owner, count(*)::int AS tokens
        FROM tokens
        WHERE state = 'VALID'
        GROUP BY owner_email
        ORDER BY tokens DESC, owner_email ASC
        LIMIT 30
      `),
      app.pool.query<{ n: number }>(`
        SELECT coalesce(sum(t.tokens),0)::int AS n FROM (
          SELECT count(*) AS tokens
          FROM tokens
          WHERE state = 'VALID'
          GROUP BY owner_email
          ORDER BY count(*) DESC
          LIMIT 10
        ) t
      `),
      app.pool.query<{ n: number }>(`
        SELECT coalesce(sum(t.tokens),0)::int AS n FROM (
          SELECT count(*) AS tokens
          FROM tokens
          WHERE state = 'VALID'
          GROUP BY owner_email
          ORDER BY count(*) DESC
          LIMIT 30
        ) t
      `),
      // Per-domain user counts. We classify into providers/regions in JS so
      // we don't have to keep two giant CASE expressions in lockstep with
      // the Set/list above.
      app.pool.query<{ domain: string; n: number }>(`
        SELECT lower(split_part(email, '@', 2)) AS domain, count(*)::int AS n
        FROM users
        GROUP BY domain
      `),
      app.pool.query<{ key: string; count: string }>(`
        SELECT key, count::text AS count FROM request_metrics
        WHERE metric_type='endpoint' ORDER BY count DESC LIMIT 20
      `),
      app.pool.query<{ key: string; count: string }>(`
        SELECT key, count::text AS count FROM request_metrics
        WHERE metric_type='client' ORDER BY count DESC LIMIT 20
      `),
      app.pool.query<{ key: string; count: string; last_client: string | null }>(`
        SELECT key, count::text AS count, last_client FROM request_metrics
        WHERE metric_type='source' ORDER BY count DESC LIMIT 10
      `),
    ]);

    const totalMinted = minted[0]!.n;
    const totalCirculating = circ[0]!.n;
    const totalUsers = users[0]!.n;

    const opts = {
      baseBits: app.config.difficultyBits,
      epochSize: app.config.mintEpochSize,
      maxSupply: app.config.mintMaxSupply,
    };
    const scheduledBits = difficultyForSupply(totalMinted, opts);
    const currentDifficultyBits = Math.max(app.config.difficultyFloor, scheduledBits);
    const info = epochInfo(totalMinted, opts);
    const epochProgress = (totalMinted % app.config.mintEpochSize) / app.config.mintEpochSize;

    const top_miners = topRows.slice(0, 10).map((r, i) => ({
      rank: i + 1,
      email_masked: maskEmail(r.owner),
      tokens: r.tokens,
      percent: totalCirculating > 0 ? (r.tokens / totalCirculating) * 100 : 0,
    }));

    const top10Tokens = top10Rows[0]!.n;
    const top30Tokens = top30Rows[0]!.n;
    const concentration = {
      top10_tokens: top10Tokens,
      top30_tokens: top30Tokens,
      others_tokens: Math.max(0, totalCirculating - top30Tokens),
      top10_percent: totalCirculating > 0 ? (top10Tokens / totalCirculating) * 100 : 0,
      top30_percent: totalCirculating > 0 ? (top30Tokens / totalCirculating) * 100 : 0,
      others_percent: totalCirculating > 0
        ? Math.max(0, 100 - (top30Tokens / totalCirculating) * 100)
        : 0,
      others_user_count: Math.max(0, totalUsers - 30),
    };

    const providerCounts = new Map<string, number>();
    const regionCounts = new Map<string, number>();
    for (const name of PROVIDER_ORDER) providerCounts.set(name, 0);
    for (const name of REGION_ORDER) regionCounts.set(name, 0);
    for (const r of domainRows) {
      const provider = providerFromDomain(r.domain);
      providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + r.n);
      const region = regionFromDomain(r.domain);
      regionCounts.set(region, (regionCounts.get(region) ?? 0) + r.n);
    }
    const email_providers = PROVIDER_ORDER.map(name => ({
      name,
      count: providerCounts.get(name) ?? 0,
    }));
    const regions = REGION_ORDER.map(name => {
      const count = regionCounts.get(name) ?? 0;
      return {
        name,
        count,
        percent: totalUsers > 0 ? (count / totalUsers) * 100 : 0,
      };
    });

    const endpoint_traffic = endpointRows.map(r => ({
      endpoint: r.key,
      requests: Number(r.count),
    }));
    const total_requests = endpoint_traffic.reduce((s, r) => s + r.requests, 0);
    const miningRequests = endpoint_traffic
      .filter(r => r.endpoint === '/challenge' || r.endpoint === '/mint')
      .reduce((s, r) => s + r.requests, 0);
    const mining_request_share = total_requests > 0 ? (miningRequests / total_requests) * 100 : 0;

    const clients = clientRows.map(r => ({
      name: r.key,
      requests: Number(r.count),
    }));
    const traffic_sources = sourceRows.map((r, i) => ({
      rank: i + 1,
      source_masked: r.key,
      client: r.last_client,
      requests: Number(r.count),
    }));
    const top10SourceRequests = traffic_sources.reduce((s, r) => s + r.requests, 0);

    return {
      generated_at: new Date().toISOString(),
      auto_update_seconds: STATS_CACHE_MS / 1000,
      live: {
        miners: totalUsers,
        circulating: totalCirculating,
        transferred: transferred[0]!.n,
        minted: totalMinted,
        max_supply: app.config.mintMaxSupply,
        percent_minted: app.config.mintMaxSupply > 0
          ? (totalMinted / app.config.mintMaxSupply) * 100
          : 0,
        remaining: Math.max(0, app.config.mintMaxSupply - totalMinted),
      },
      difficulty: {
        current_bits: currentDifficultyBits,
        next_bits: info.nextDifficultyBits,
        epoch: info.epoch,
        epoch_size: app.config.mintEpochSize,
        in_epoch: totalMinted % app.config.mintEpochSize,
        coins_to_next: info.coinsToNext,
        epoch_progress_percent: epochProgress * 100,
        is_capped: info.isCapped,
      },
      top_miners,
      concentration,
      email_providers,
      regions,
      clients,
      traffic_sources,
      traffic_total_requests: total_requests,
      traffic_top10_share_percent: total_requests > 0
        ? (top10SourceRequests / total_requests) * 100
        : 0,
      endpoint_traffic,
      mining_request_share_percent: mining_request_share,
    };
  }

  app.get('/stats', async () => {
    if (cached && Date.now() - cached.ts < STATS_CACHE_MS) return cached.body;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const body = await refresh();
        cached = { ts: Date.now(), body };
        return body;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  });
}

// Test-only export: clear the route-local cache between assertions.
// Cache state is closed over inside statsRoutes; tests build a fresh app
// per case so they get a fresh cache for free. (Exported so we don't
// accidentally remove the route in a refactor without flagging this.)
export const _statsTestExports = { maskEmail, providerFromDomain, regionFromDomain };
