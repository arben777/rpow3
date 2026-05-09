import { createPool, runMigrations } from '../src/db.js';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { FakeMailer } from '../src/mailer.js';
import { buildApp } from '../src/buildApp.js';
import { createImageStore } from '../src/billboard/imageStorage.js';
import { parseAdminEmails } from '../src/admin.js';
import pg from 'pg';

export interface TestAppOverrides {
  /** Force LIGHTNING_ENABLED=true with the supplied stub phoenixd. */
  phoenixd?: any;
  /** Override the admin email set. */
  adminEmails?: string;
  /** Override RPOW_PER_CELL (default 100; some tests want 4). */
  rpowPerCell?: number;
  /** Override the per-email cap (default 100). */
  perEmailOwnedCapCells?: number;
}

export async function makeTestApp(overrides: TestAppOverrides = {}): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: Pool;
  mailer: FakeMailer;
  cleanup: () => Promise<void>;
}> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL required');

  const schema = `t_${randomBytes(4).toString('hex')}`;

  // Use an admin pool to create the schema
  const adminPool = createPool(url);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  await adminPool.end();

  // Create a pool that always uses this schema via search_path
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    options: `-c search_path=${schema}`,
  });

  await runMigrations(pool);
  const mailer = new FakeMailer();
  const imageStore = createImageStore({ backend: 'memory' });
  const app = await buildApp({
    pool,
    mailer,
    test: true,
    config: {
      sessionSecret: 'x'.repeat(32),
      magicLinkBaseUrl: 'http://test',
      difficultyBits: 8,
      difficultyFloor: 4,
      mintEpochSize: 10,
      mintMaxSupply: 21,
      signingPrivateKeyHex: '11'.repeat(32),
      signingPublicKeyHex: '22'.repeat(32),
      webOrigin: 'http://web.test',
      secureCookies: false,
      billboard: {
        rpowPerCell: overrides.rpowPerCell ?? 100,
        rakeBps: 100,
        noListHoldHours: 24,
        perEmailOwnedCapCells: overrides.perEmailOwnedCapCells ?? 100,
        lightningEnabled: !!overrides.phoenixd,
        storagePublicUrlBase: null,
        serverPublicUrl: 'http://test',
      },
      lightning: {
        enabled: !!overrides.phoenixd,
        domain: 'test.local',
        rakeBps: 100,
        maxBalanceMsat: 10_000_000_000,
        maxPayout24hMsat: 1_000_000_000,
        webhookSecret: 'test-secret',
      },
      moderation: { enabled: false },
      admin: parseAdminEmails(overrides.adminEmails),
      imageStore,
      phoenixd: overrides.phoenixd ?? null,
    },
  });
  return {
    app, pool, mailer,
    cleanup: async () => {
      await app.close();
      // Use a fresh pool to drop the schema since main pool may be closed
      const cleanPool = createPool(url);
      await cleanPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanPool.end();
      await pool.end();
    },
  };
}
