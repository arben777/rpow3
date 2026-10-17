import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, runMigrations } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url;

describe.skipIf(skip)('db migrations', () => {
  const pool = createPool(url!);
  beforeAll(async () => { await runMigrations(pool); });
  afterAll(async () => { await pool.end(); });

  it('creates tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
    );
    const names = rows.map(r => r.table_name);
    for (const t of ['users', 'magic_links', 'challenges', 'tokens', 'transfers', 'schema_migrations']) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent', async () => {
    await runMigrations(pool); // run again, no error
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations');
    expect(rowCount).toBeGreaterThan(0);
  });
});

describe.skipIf(skip)('runMigrations under concurrent replicas', () => {
  it('two runners on the same fresh schema do not collide', async () => {
    const { randomBytes } = await import('node:crypto');
    const pg = (await import('pg')).default;
    const schema = `m_${randomBytes(4).toString('hex')}`;
    const admin = createPool(url!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const mk = () => new pg.Pool({ connectionString: url!, max: 4, options: `-c search_path=${schema}` });
    const a = mk(); const b = mk();
    try {
      // Simulates two Railway replicas booting at once. Before the advisory
      // lock this raced CREATE INDEX IF NOT EXISTS and one side crashed on a
      // pg_class duplicate-key error.
      await Promise.all([runMigrations(a), runMigrations(b)]);
      const { rows } = await a.query('SELECT count(*)::int AS n FROM schema_migrations');
      expect(rows[0].n).toBeGreaterThan(0);
      const { rows: idx } = await a.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='tokens_root_issued_idx'`, [schema],
      );
      expect(idx).toHaveLength(1);
    } finally {
      await a.end(); await b.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
