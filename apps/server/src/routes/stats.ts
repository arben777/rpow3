import type { FastifyInstance } from 'fastify';
import { difficultyForSupply, epochInfo } from '../schedule.js';

/**
 * Public /stats endpoint — drives the stats.rpow3.com dashboard.
 *
 * Aggregates network-wide counters, the miner leaderboard, supply
 * concentration, and demographic breakdowns derived from email domains.
 *
 * Cached 60 s and coalesced behind a single in-flight promise. The
 * heaviest query (top miners + per-miner totals) does a full GROUP BY on
 * tokens, which we don't want firing per-poller. 60 s of staleness is
 * invisible on a stats page.
 *
 * NB: an earlier revision also exposed per-endpoint, per-IP, and per-
 * client request counts. Those were yanked because at typical viral
 * traffic levels the counters take days to accumulate to anything that
 * looks accurate next to /challenge's true volume — they were misleading
 * more than they were useful. The supporting `request_metrics` table
 * (migration 009) is intentionally left in place but unread; if we ever
 * add IP-geolocation or revive client tracking, the schema's already
 * there.
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

/**
 * Bucket a domain into a regional cohort. The order of the if-cascade
 * matters — country-code TLDs (.cn, .br, .jp) take priority over the
 * generic catch-all so e.g. yahoo.co.jp counts as "Other Asia", not
 * "Generic providers". When nothing matches, the address is on a
 * region-agnostic provider (gmail/outlook/etc.) and we honestly admit
 * we can't infer location from email alone.
 */
function regionFromDomain(domain: string): string {
  const d = domain.toLowerCase();

  // China — country code TLD plus the major Chinese mailbox providers.
  if (d.endsWith('.cn')
      || d === 'qq.com' || d === 'foxmail.com'
      || d === '163.com' || d === '126.com' || d === 'yeah.net'
      || d === 'sina.com' || d === 'sina.com.cn'
      || d === 'sohu.com' || d === 'aliyun.com') return 'China';

  // India / South Asia. Catches .in (incl. .co.in, .ac.in) and neighbors.
  if (d.endsWith('.in') || d.endsWith('.pk') || d.endsWith('.bd')
      || d.endsWith('.lk') || d.endsWith('.np') || d.endsWith('.bt')
      || d === 'rediffmail.com' || d === 'rediff.com') return 'India / South Asia';

  // Other Asia — Japan, Korea, SE Asia.
  if (d.endsWith('.jp') || d.endsWith('.kr') || d.endsWith('.tw')
      || d.endsWith('.hk') || d.endsWith('.sg') || d.endsWith('.my')
      || d.endsWith('.id') || d.endsWith('.th') || d.endsWith('.vn')
      || d.endsWith('.ph') || d.endsWith('.mn') || d.endsWith('.kh')
      || d.endsWith('.la') || d.endsWith('.mm')
      || d === 'naver.com' || d === 'daum.net'
      || d === 'hanmail.net' || d === 'kakao.com') return 'Other Asia';

  // Russia / CIS — Russia, Belarus, Ukraine, Central Asia.
  if (d.endsWith('.ru') || d.endsWith('.by') || d.endsWith('.ua')
      || d.endsWith('.kz') || d.endsWith('.uz') || d.endsWith('.am')
      || d.endsWith('.ge') || d.endsWith('.az') || d.endsWith('.md')
      || d === 'yandex.ru' || d === 'yandex.com'
      || d === 'mail.ru' || d === 'rambler.ru' || d === 'inbox.ru'
      || d === 'list.ru' || d === 'bk.ru') return 'Russia / CIS';

  // Europe — EU + UK + EFTA. .uk catches .co.uk too.
  if (d.endsWith('.de') || d.endsWith('.fr') || d.endsWith('.uk')
      || d.endsWith('.it') || d.endsWith('.es') || d.endsWith('.nl')
      || d.endsWith('.pl') || d.endsWith('.se') || d.endsWith('.fi')
      || d.endsWith('.no') || d.endsWith('.dk') || d.endsWith('.cz')
      || d.endsWith('.sk') || d.endsWith('.hu') || d.endsWith('.gr')
      || d.endsWith('.ro') || d.endsWith('.bg') || d.endsWith('.hr')
      || d.endsWith('.si') || d.endsWith('.lt') || d.endsWith('.lv')
      || d.endsWith('.ee') || d.endsWith('.ie') || d.endsWith('.pt')
      || d.endsWith('.be') || d.endsWith('.at') || d.endsWith('.ch')
      || d.endsWith('.lu') || d.endsWith('.is') || d.endsWith('.eu')
      || d === 'gmx.de' || d === 'gmx.com' || d === 'web.de'
      || d === 't-online.de' || d === 'orange.fr' || d === 'wanadoo.fr'
      || d === 'free.fr' || d === 'libero.it' || d === 'tiscali.it'
      || d === 'seznam.cz') return 'Europe';

  // Middle East — Turkey + GCC + Levant + Iran.
  if (d.endsWith('.tr') || d.endsWith('.sa') || d.endsWith('.ae')
      || d.endsWith('.il') || d.endsWith('.ir') || d.endsWith('.iq')
      || d.endsWith('.qa') || d.endsWith('.kw') || d.endsWith('.om')
      || d.endsWith('.lb') || d.endsWith('.jo') || d.endsWith('.sy')
      || d.endsWith('.ye') || d.endsWith('.bh')
      || d === 'walla.com' || d === 'walla.co.il') return 'Middle East';

  // Latin America — South + Central America + Caribbean. NB: .co also
  // matches generic "company" usage, but treating it as Colombia is the
  // closest signal we have from email alone.
  if (d.endsWith('.br') || d.endsWith('.mx') || d.endsWith('.ar')
      || d.endsWith('.co') || d.endsWith('.cl') || d.endsWith('.pe')
      || d.endsWith('.ve') || d.endsWith('.uy') || d.endsWith('.py')
      || d.endsWith('.bo') || d.endsWith('.ec') || d.endsWith('.gt')
      || d.endsWith('.cr') || d.endsWith('.pa') || d.endsWith('.do')
      || d.endsWith('.pr') || d.endsWith('.ni') || d.endsWith('.sv')
      || d.endsWith('.hn') || d.endsWith('.cu')
      || d === 'uol.com.br' || d === 'bol.com.br' || d === 'terra.com.br'
      || d === 'globo.com') return 'Latin America';

  // Africa.
  if (d.endsWith('.za') || d.endsWith('.ng') || d.endsWith('.ke')
      || d.endsWith('.eg') || d.endsWith('.gh') || d.endsWith('.ma')
      || d.endsWith('.dz') || d.endsWith('.tn') || d.endsWith('.et')
      || d.endsWith('.ug') || d.endsWith('.tz') || d.endsWith('.sn')
      || d.endsWith('.ci') || d.endsWith('.cm') || d.endsWith('.zw')
      || d.endsWith('.mz') || d.endsWith('.ao') || d.endsWith('.rw')) return 'Africa';

  // Oceania.
  if (d.endsWith('.au') || d.endsWith('.nz')
      || d.endsWith('.fj') || d.endsWith('.pg')) return 'Oceania';

  // North America — only .ca; .us is rare for personal email and gmail
  // dominates US users anyway, so they end up in Generic providers below.
  if (d.endsWith('.ca')) return 'North America';

  // Catch-all: gmail / outlook / yahoo / icloud / hotmail / etc. We don't
  // pretend to know region for these.
  return 'Generic providers';
}

const PROVIDER_ORDER = ['Gmail', 'QQ Mail', 'Outlook', '163 Mail', 'Hotmail', 'iCloud', 'Yahoo', 'Other'] as const;
const REGION_ORDER = [
  'China',
  'India / South Asia',
  'Other Asia',
  'Europe',
  'Russia / CIS',
  'Middle East',
  'Latin America',
  'Africa',
  'Oceania',
  'North America',
  'Generic providers',
] as const;

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
      { rows: domainRows },
    ] = await Promise.all([
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL`),
      app.pool.query<{ n: number }>(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE state='VALID'`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`),
      // Top 30 miners by tokens currently held — VALID supply, not lifetime
      // mints. Mirrors what wallet pages show. We materialize 30 rows so
      // we can also derive the top10/top30 supply share by summing in JS,
      // avoiding two extra GROUP BY passes that previously hit the 5 s
      // statement_timeout under viral load.
      app.pool.query<{ owner: string; tokens: number }>(`
        SELECT owner_email AS owner, count(*)::int AS tokens
        FROM tokens
        WHERE state = 'VALID'
        GROUP BY owner_email
        ORDER BY tokens DESC, owner_email ASC
        LIMIT 30
      `),
      // Per-domain user counts. We classify into providers/regions in JS so
      // we don't have to keep two giant CASE expressions in lockstep with
      // the Set/list above.
      app.pool.query<{ domain: string; n: number }>(`
        SELECT lower(split_part(email, '@', 2)) AS domain, count(*)::int AS n
        FROM users
        GROUP BY domain
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

    const top10Tokens = topRows.slice(0, 10).reduce((s, r) => s + r.tokens, 0);
    const top30Tokens = topRows.reduce((s, r) => s + r.tokens, 0);
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

    // Region display rules:
    //   - Drop empty buckets so the page doesn't list ten zero-count rows.
    //   - Sort the inferable cohorts by count descending (most-represented
    //     country first).
    //   - Always pin "Generic providers" to the bottom regardless of size,
    //     so the geographic distribution is visually emphasized — that
    //     bucket is typically the largest by far (gmail dominance) but
    //     contains no regional signal.
    const allRegions = REGION_ORDER.map(name => {
      const count = regionCounts.get(name) ?? 0;
      return {
        name,
        count,
        percent: totalUsers > 0 ? (count / totalUsers) * 100 : 0,
      };
    });
    const generic = allRegions.find(r => r.name === 'Generic providers')!;
    const inferable = allRegions
      .filter(r => r.name !== 'Generic providers' && r.count > 0)
      .sort((a, b) => b.count - a.count);
    const regions = generic.count > 0 ? [...inferable, generic] : inferable;

    const inferableCount = inferable.reduce((s, r) => s + r.count, 0);
    const inferablePercent = totalUsers > 0 ? (inferableCount / totalUsers) * 100 : 0;

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
      region_inferable_count: inferableCount,
      region_inferable_percent: inferablePercent,
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

export const _statsTestExports = { maskEmail, providerFromDomain, regionFromDomain };
