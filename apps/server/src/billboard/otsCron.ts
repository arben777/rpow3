// Daily-OTS cron: stamps the canonical canvas state once per UTC day.
//
// We schedule the next firing at the next 00:05 UTC (5 minutes past
// midnight, to give any in-flight midnight transactions time to settle
// into the snapshot). On each fire we:
//   1) Snapshot the canonical state
//   2) Submit the digest to the OTS calendar pool
//   3) Insert a row into canvas_timestamps with the proof
//   4) Reschedule for the next day
//
// The cron runs in-process when OTS_CRON_ENABLED=true. In multi-replica
// production setups, only one replica should run this — gate by the
// usual leader election (e.g. set OTS_CRON_ENABLED=true on a single
// "worker" replica) or add a Postgres advisory lock here. We've left the
// advisory lock out because Railway's normal operating model is one
// "cron worker" replica anyway.

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { snapshotCanonical } from './state.js';
import { stampDigest, type OtsCalendar } from './ots.js';

// Arbitrary 32-bit constant for the advisory lock; pick something
// distinctive so it won't collide with another caller.
const ADVISORY_LOCK_KEY = 0xb111b0a4;

export interface OtsCronOptions {
  pool: Pool;
  log: Logger;
  calendars: OtsCalendar[];
  /** Override "now" (used in tests). */
  nowFn?: () => Date;
  /** Override fetch (used in tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Compute the next UTC firing instant. Default is 00:05 UTC tomorrow.
 * Exposed for testability.
 */
export function nextFireAt(now: Date): Date {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 5, 0, 0,
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Run a single stamping pass. Returns the new row id, or null on no-op/failure. */
export async function stampOnce(opts: OtsCronOptions): Promise<number | null> {
  const { pool, log, calendars, fetchImpl = fetch } = opts;

  // Postgres advisory lock so a concurrent replica doesn't double-stamp.
  // pg_try_advisory_lock returns true if the lock was acquired, false
  // otherwise — we only proceed in the "true" branch.
  const got = await pool.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS ok',
    [ADVISORY_LOCK_KEY],
  );
  if (!got.rows[0]?.ok) {
    log.info('OTS stamp: advisory lock busy, skipping');
    return null;
  }
  try {
    const snap = await snapshotCanonical(pool);
    let proofBlob: Buffer | null = null;
    let calendarUrl: string | null = null;
    let status = 'submitted';
    if (calendars.length > 0) {
      try {
        const r = await stampDigest(snap.sha256, calendars, fetchImpl);
        proofBlob = r.proof;
        calendarUrl = r.calendarUrl;
      } catch (e: any) {
        status = `calendar_unreachable: ${String(e?.message ?? e).slice(0, 200)}`;
        log.warn({ err: String(e) }, 'OTS stamp: all calendars failed; row inserted with no proof');
      }
    } else {
      status = 'calendars_disabled';
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO canvas_timestamps
         (state_sha256, slot_count, total_rpow_burned, ots_proof_blob, ots_calendar_url, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id`,
      [snap.sha256, snap.slotCount, snap.totalRpow, proofBlob, calendarUrl, status],
    );
    const id = Number(rows[0]!.id);
    log.info({
      id, sha256: snap.sha256.toString('hex'), slot_count: snap.slotCount, status,
    }, 'OTS stamp completed');
    return id;
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}

/** Start the long-lived cron. Returns a stop function. */
export function startOtsCron(opts: OtsCronOptions): () => void {
  const nowFn = opts.nowFn ?? (() => new Date());
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = () => {
    if (stopped) return;
    const now = nowFn();
    const next = nextFireAt(now);
    const delay = Math.max(60_000, next.getTime() - now.getTime());
    timer = setTimeout(async () => {
      try { await stampOnce(opts); } catch (e: any) {
        opts.log.error({ err: String(e) }, 'OTS cron firing failed');
      }
      schedule();
    }, delay);
    // Allow process exit even if the timer is pending.
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
