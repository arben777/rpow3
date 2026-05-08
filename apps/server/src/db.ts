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
  return new Pool({
    connectionString: databaseUrl,
    max,
    // Release idle connections so Postgres can reclaim the slot. Without
    // this, idle connections sit forever and the second replica can't
    // open new ones when its own users come online.
    idleTimeoutMillis: 30_000,
    // Fail fast if the pool can't get a connection within 5s. Better
    // than hanging the request indefinitely.
    connectionTimeoutMillis: 5_000,
  });
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

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const dir = join(__dirname, '..', 'migrations');
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f]);
    if (rows.length) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    await withTx(pool, async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(filename) VALUES($1)', [f]);
    });
  }
}
