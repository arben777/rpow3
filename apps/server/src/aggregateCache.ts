import type { Pool, PoolClient } from 'pg';
import { withTx } from './db.js';

/**
 * Caching for expensive, network-wide aggregate endpoints (/ledger, /stats).
 *
 * These endpoints run full-table aggregates that get slower as the token
 * table grows. The previous inline cache only remembered *successful*
 * refreshes, so once the aggregates started exceeding statement_timeout
 * every request re-fired the whole batch, every batch died at the
 * timeout, the endpoint 500'd continuously, and the doomed queries kept
 * pool connections away from /auth and /mint.
 *
 * This helper changes the failure behaviour:
 *   - A fresh result is served straight from cache for `ttlMs`.
 *   - A stale result is served immediately while one refresh runs in the
 *     background (stale-while-revalidate), so a slow refresh never makes
 *     a request wait.
 *   - If a refresh fails, the last good result keeps being served and the
 *     DB is left alone for `retryAfterMs` before another attempt.
 *   - Only when there has never been a good result does a failure reach
 *     the caller, as a 503 rather than a 500, and still rate-limited by
 *     `retryAfterMs` so a cold replica can't stampede the DB either.
 */
export interface CachedAggregateOpts<T> {
  /** Serve the cached body without refreshing for this long after a successful refresh. */
  ttlMs: number;
  /** After a failed refresh, do not touch the DB again for this long. */
  retryAfterMs: number;
  /** Human-readable name used in the 503 message, e.g. 'ledger'. */
  name: string;
  refresh: () => Promise<T>;
  onError?: (e: unknown) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class AggregateUnavailableError extends Error {
  statusCode = 503;
  code = 'AGGREGATE_UNAVAILABLE';
  constructor(name: string) {
    super(`${name} temporarily unavailable; retry shortly`);
  }
}

export function makeCachedAggregate<T>(opts: CachedAggregateOpts<T>): () => Promise<T> {
  const now = opts.now ?? Date.now;
  let cached: { ts: number; body: T } | null = null;
  let lastFailureTs: number | null = null;
  let inflight: Promise<T> | null = null;

  function startRefresh(): Promise<T> {
    const p = (async () => {
      try {
        const body = await opts.refresh();
        cached = { ts: now(), body };
        lastFailureTs = null;
        return body;
      } catch (e) {
        lastFailureTs = now();
        opts.onError?.(e);
        if (cached) return cached.body;
        throw new AggregateUnavailableError(opts.name);
      } finally {
        inflight = null;
      }
    })();
    inflight = p;
    return p;
  }

  return async () => {
    const t = now();
    if (cached && t - cached.ts < opts.ttlMs) return cached.body;

    const inBackoff = lastFailureTs != null && t - lastFailureTs < opts.retryAfterMs;

    if (cached) {
      // Stale: hand back what we have right away and revalidate behind
      // the scenes (unless we're backing off after a recent failure).
      if (!inflight && !inBackoff) {
        // Errors are handled inside startRefresh; nothing can escape here.
        void startRefresh();
      }
      return cached.body;
    }

    // Cold: nothing to serve yet.
    if (inflight) return inflight;
    if (inBackoff) throw new AggregateUnavailableError(opts.name);
    return startRefresh();
  };
}

/**
 * Run `fn` on a single pooled connection with its own statement_timeout.
 *
 * Aggregates share one connection instead of taking one per query, so a
 * refresh costs the pool exactly one slot however many queries it runs
 * (pg serialises concurrent queries on one client, so Promise.all still
 * works). SET LOCAL scopes the wider timeout to this transaction; the
 * app-wide 5 s cap from db.ts resumes for everything else.
 */
export async function withAggregateClient<T>(
  pool: Pool,
  statementTimeoutMs: number,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const ms = Math.max(0, Math.floor(statementTimeoutMs));
  return withTx(pool, async (c) => {
    await c.query(`SET LOCAL statement_timeout = ${ms}`);
    return fn(c);
  });
}
