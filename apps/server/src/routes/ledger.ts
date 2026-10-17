import type { FastifyInstance } from 'fastify';
import { difficultyForSupply, epochInfo } from '../schedule.js';
import { makeCachedAggregate, series, withAggregateClient } from '../aggregateCache.js';

// /ledger is hit by every visitor to the ledger page. Each refresh runs
// several whole-table aggregates on tokens, and those get slower as the
// table grows. The refresh is cached and coalesced (see aggregateCache.ts):
// a fresh body is served for LEDGER_CACHE_MS, a stale one is served
// immediately while a single background refresh runs, and if a refresh
// fails the last good body keeps being served while the DB gets a
// LEDGER_RETRY_MS breather. 15 s of staleness is invisible in a ledger view.
//
// All queries in one refresh share a single pooled connection with their
// own statement_timeout, so a refresh costs the pool exactly one slot and
// can't starve /auth or /mint even when the aggregates run long.
const LEDGER_CACHE_MS = 15_000;
const LEDGER_RETRY_MS = 15_000;
const LEDGER_STATEMENT_TIMEOUT_MS = 20_000;

export async function ledgerRoutes(app: FastifyInstance) {
  async function refresh() {
    return withAggregateClient(app.pool, LEDGER_STATEMENT_TIMEOUT_MS, async (c) => {
    const [
      { rows: minted },
      { rows: transferred },
      { rows: circ },
      { rows: users },
      { rows: growthRows },
      { rows: doublingRows },
      { rows: firstSignupRows },
      { rows: rateRows },
    ] = await series([
      () => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL`),
      () => c.query<{ n: number }>(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers`),
      () => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE state='VALID'`),
      () => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`),
      // 5-minute cumulative user count. Window function adds new_users into
      // a running total per bin. date_bin (Postgres 14+) gives evenly-aligned
      // 5-min buckets anchored at epoch.
      () => c.query<{ at: Date; users: number }>(`
        WITH binned AS (
          SELECT date_bin('5 minutes', created_at, TIMESTAMPTZ '2000-01-01') AS bucket,
                 count(*) AS new_users
          FROM users GROUP BY bucket
        )
        SELECT bucket AS at,
               sum(new_users) OVER (ORDER BY bucket)::int AS users
        FROM binned ORDER BY bucket
      `),
      // Doubling time: with N users, the user at offset floor((N-1)/2) was
      // signing up when the count crossed N/2. (now - that.created_at) is
      // the time it took to double from N/2 to N. NULL when N < 2.
      () => c.query<{ seconds: string | null }>(`
        WITH t AS (SELECT count(*)::int AS n FROM users)
        SELECT EXTRACT(epoch FROM (now() - u.created_at))::bigint::text AS seconds
        FROM users u, t
        WHERE t.n >= 2
        ORDER BY u.created_at ASC
        OFFSET (SELECT GREATEST(0, FLOOR((n - 1) / 2.0))::int FROM t)
        LIMIT 1
      `),
      () => c.query<{ at: Date | null }>(`SELECT min(created_at) AS at FROM users`),
      // Recent mint rate over the last 30 minutes — used to estimate when the
      // next +1-bit difficulty bump will land. 30m is wide enough to be stable
      // and tight enough to reflect current load. count(*) on a partial range
      // is fine; /ledger is cached 5s anyway.
      () => c.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM tokens
        WHERE parent_token_id IS NULL
          AND issued_at > now() - interval '30 minutes'
      `),
    ]);
    const totalMinted = minted[0]!.n;
    const opts = {
      baseBits: app.config.difficultyBits,
      epochSize: app.config.mintEpochSize,
      maxSupply: app.config.mintMaxSupply,
    };
    const scheduledBits = difficultyForSupply(totalMinted, opts);
    const currentDifficultyBits = Math.max(app.config.difficultyFloor, scheduledBits);
    const info = epochInfo(totalMinted, opts);
    const growth = growthRows.map(r => ({ at: r.at.toISOString(), users: r.users }));
    const doublingSeconds = doublingRows[0]?.seconds != null
      ? Number(doublingRows[0]!.seconds)
      : null;
    const firstSignupAt = firstSignupRows[0]?.at ? firstSignupRows[0]!.at!.toISOString() : null;

    // Last and next +1-bit adjustment.
    let lastAdjustmentAt: string | null = null;
    if (info.epoch >= 1) {
      // The N-th mint in chronological order brought minted_count to N. The
      // (epoch * epochSize)-th mint is the one that crossed the most recent
      // milestone — its issued_at is the moment of the last difficulty bump.
      const offset = info.epoch * app.config.mintEpochSize - 1;
      const { rows: adjRows } = await c.query<{ at: Date }>(
        `SELECT issued_at AS at FROM tokens
         WHERE parent_token_id IS NULL
         ORDER BY issued_at ASC OFFSET $1 LIMIT 1`,
        [offset],
      );
      if (adjRows[0]?.at) lastAdjustmentAt = adjRows[0].at.toISOString();
    }
    const recentMints = rateRows[0]!.n;
    const ratePerSec = recentMints / 1800;
    let nextAdjustmentEtaSeconds: number | null = null;
    if (!info.isCapped && info.coinsToNext > 0 && ratePerSec > 0) {
      nextAdjustmentEtaSeconds = Math.round(info.coinsToNext / ratePerSec);
    }

    return {
      total_minted: totalMinted,
      total_transferred: transferred[0]!.n,
      circulating_supply: circ[0]!.n,
      current_difficulty_bits: currentDifficultyBits,
      user_count: users[0]!.n,
      max_supply: app.config.mintMaxSupply,
      epoch: info.epoch,
      epoch_size: app.config.mintEpochSize,
      next_milestone_at: info.nextMilestoneAt,
      coins_until_next_milestone: info.coinsToNext,
      next_difficulty_bits: info.nextDifficultyBits,
      is_capped: info.isCapped,
      user_growth: growth,
      doubling_seconds: doublingSeconds,
      first_signup_at: firstSignupAt,
      last_adjustment_at: lastAdjustmentAt,
      next_adjustment_eta_seconds: nextAdjustmentEtaSeconds,
      mint_rate_per_minute: Math.round(ratePerSec * 60),
    };
    });
  }

  const getLedger = makeCachedAggregate({
    name: 'ledger',
    ttlMs: LEDGER_CACHE_MS,
    retryAfterMs: LEDGER_RETRY_MS,
    refresh,
    onError: (e) => app.log.error({ err: e }, '/ledger refresh failed; serving last good result if any'),
  });

  app.get('/ledger', async () => getLedger());
}
