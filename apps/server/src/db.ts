import { Pool, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createPool(databaseUrl: string): Pool {
  // Postgres' max_connections is finite (100 by default; many hosted
  // tiers cap lower). With multiple Railway replicas each opening their
  // own pool, the total app-side connection count is `replicas × max`.
  // Under viral load on a small Postgres tier this blew past the cap and
  // Postgres started rejecting with `FATAL: too many clients already`.
  //
  // Tunable via DB_POOL_MAX. Default 15 fits comfortably under any
  // hobby-tier max_connections even with 2-4 replicas. Once you've moved
  // to a connection pooler (PgBouncer / Neon's built-in pooler) or
  // upgraded the Postgres tier, bump this back up.
  const max = Math.max(1, Number(process.env.DB_POOL_MAX ?? 15));
  const pool = new Pool({
    connectionString: databaseUrl,
    max,
    // Release idle connections so Postgres can reclaim the slot. Without
    // this, idle connections sit forever and the second replica can't
    // open new ones when its own users come online.
    idleTimeoutMillis: 30_000,
    // Fail fast if the pool can't get a connection within 5s. Better
    // than hanging the request indefinitely.
    connectionTimeoutMillis: 5_000,
    // Postgres-side guardrails so the *server* itself can self-heal from
    // stuck queries and orphaned transactions:
    //   - statement_timeout: 5s. Any single query that runs longer is
    //     killed. Saves us from one slow query holding a connection
    //     hostage for the whole pool.
    //   - idle_in_transaction_session_timeout: 10s. If a transaction is
    //     open but doing nothing (e.g. the app crashed mid-tx), Postgres
    //     closes the session and releases its locks. This is the direct
    //     fix for the "unexpected EOF on client connection with an open
    //     transaction" log spam — Postgres won't hold dead transactions
    //     open waiting for app-side reconnects.
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  // pg emits 'error' on the pool when an *idle* client's socket drops:
  // Postgres restarting, a network blip, the server closing the session.
  // With no listener Node treats that as an unhandled 'error' event and
  // exits the process. That is how a Postgres restart on Railway took
  // every server replica down at the same moment ("Connection terminated
  // unexpectedly ... Emitted 'error' event on BoundPool instance"). Log
  // it instead; the pool drops the dead client and the next checkout
  // opens a fresh connection.
  pool.on('error', (err) => {
    console.error(`[pg] idle client lost its connection (${err.message}); pool will reconnect on next use`);
  });
  return pool;
}

/** True for errors that mean "Postgres is not reachable right now", as opposed to a bad query. */
export function isConnectionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code ?? '';
  return (
    /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE)$/.test(code) ||
    /Connection terminated|connection timeout|timeout exceeded when trying to connect|ECONNREFUSED|ENOTFOUND|ECONNRESET|the database system is (starting|shutting) (up|down)/i.test(msg)
  );
}

/**
 * Run migrations, retrying while Postgres is unreachable.
 *
 * After a Postgres restart on Railway the server replicas come back before
 * the database is accepting connections (and before postgres.railway.internal
 * resolves to the new container), so the very first query fails with
 * "Connection terminated due to connection timeout" and the process exits
 * — repeatedly, until the timing happens to line up. Wait and retry for a
 * bounded window instead. Genuine migration errors still throw immediately.
 */
export async function runMigrationsWithRetry(
  pool: Pool,
  opts: { maxWaitMs?: number; intervalMs?: number; log?: (msg: string) => void } = {},
): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const log = opts.log ?? ((m) => console.error(m));
  const start = Date.now();
  for (;;) {
    try {
      await runMigrations(pool);
      return;
    } catch (e) {
      const waited = Date.now() - start;
      if (!isConnectionError(e) || waited >= maxWaitMs) throw e;
      log(`[db] postgres not reachable yet (${(e as Error).message}); retrying in ${intervalMs}ms`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
}

export async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally { c.release(); }
}

// Arbitrary but fixed key for the migration advisory lock. Advisory locks
// are database-wide, so every replica that connects to the same DB
// contends on this one key.
const MIGRATION_LOCK_KEY = 7_337_001;

export async function runMigrations(pool: Pool): Promise<void> {
  const dir = join(__dirname, '..', 'migrations');
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();

  // On a deploy Railway boots several replicas at once and each one runs
  // this. Without coordination two replicas can both see a migration as
  // unapplied and run it concurrently. CREATE INDEX IF NOT EXISTS is not
  // atomic — the existence check and the catalog insert are separate — so
  // the loser crashed with
  //   duplicate key value violates unique constraint "pg_class_relname_nsp_index"
  // and the replica restarted into a crash loop until the winner committed.
  //
  // Serialise replicas behind a session-level advisory lock held on one
  // dedicated connection: the first replica applies what is missing while
  // the others block on the lock, then re-check and skip what is already
  // recorded. statement_timeout is lifted on this connection for the
  // duration so a replica waiting on a long index build isn't cancelled
  // (and the build itself isn't either). RESET restores the pool default
  // before the connection goes back.
  await withClient(pool, async (c) => {
    await c.query('SET statement_timeout = 0');
    try {
      await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      try {
        // Inside the lock: CREATE TABLE IF NOT EXISTS has the same
        // check-then-insert race as CREATE INDEX IF NOT EXISTS.
        await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
          filename TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        for (const f of files) {
          const { rows } = await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f]);
          if (rows.length) continue;
          const sql = await readFile(join(dir, f), 'utf8');
          await c.query('BEGIN');
          try {
            await c.query(sql);
            await c.query('INSERT INTO schema_migrations(filename) VALUES($1)', [f]);
            await c.query('COMMIT');
          } catch (e) {
            await c.query('ROLLBACK');
            throw e;
          }
        }
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      }
    } finally {
      await c.query('RESET statement_timeout');
    }
  });
}
