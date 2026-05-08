import type { FastifyInstance } from 'fastify';
import { difficultyForSupply, epochInfo } from '../schedule.js';

// /ledger is polled aggressively by every active client (mining UI refresh,
// status bar). Each call does 4 full-table scans on tokens (no suitable
// index for these aggregates). Without coalescing, thousands of concurrent
// pollers melt the DB.
//
// Cache the response for LEDGER_CACHE_MS and coalesce concurrent refreshes
// behind a single in-flight promise. ~5s staleness is invisible in a ledger
// view.
const LEDGER_CACHE_MS = 5_000;

export async function ledgerRoutes(app: FastifyInstance) {
  let cached: { ts: number; body: unknown } | null = null;
  let inflight: Promise<unknown> | null = null;

  async function refresh() {
    const [
      { rows: minted },
      { rows: transferred },
      { rows: circ },
      { rows: users },
      { rows: growthRows },
      { rows: doublingRows },
    ] = await Promise.all([
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL`),
      app.pool.query<{ n: number }>(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE state='VALID'`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`),
      // Hourly cumulative user count. Window function adds new_users into a
      // running total per bucket.
      app.pool.query<{ at: Date; users: number }>(`
        WITH hourly AS (
          SELECT date_trunc('hour', created_at) AS bucket, count(*) AS new_users
          FROM users GROUP BY bucket
        )
        SELECT bucket AS at,
               sum(new_users) OVER (ORDER BY bucket)::int AS users
        FROM hourly ORDER BY bucket
      `),
      // Doubling time: with N users, the user at offset floor((N-1)/2) was
      // signing up when the count crossed N/2. (now - that.created_at) is
      // the time it took to double from N/2 to N. NULL when N < 2.
      app.pool.query<{ seconds: string | null }>(`
        WITH t AS (SELECT count(*)::int AS n FROM users)
        SELECT EXTRACT(epoch FROM (now() - u.created_at))::bigint::text AS seconds
        FROM users u, t
        WHERE t.n >= 2
        ORDER BY u.created_at ASC
        OFFSET (SELECT FLOOR((n - 1) / 2.0)::int FROM t)
        LIMIT 1
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
    };
  }

  app.get('/ledger', async () => {
    if (cached && Date.now() - cached.ts < LEDGER_CACHE_MS) return cached.body;
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
