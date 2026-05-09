import { parseEnv } from './env.js';
import { createPool, runMigrations } from './db.js';
import { buildApp } from './buildApp.js';
import { ResendMailer, FakeMailer, type Mailer } from './mailer.js';
import { startMetricsFlush } from './metrics.js';

const env = parseEnv();
const pool = createPool(env.DATABASE_URL);
await runMigrations(pool);

const extraOrigins = env.EXTRA_WEB_ORIGINS
  ? env.EXTRA_WEB_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : [];

let mailer: Mailer;
if (process.env.RPOW_TEST_INBOX === 'true') {
  const fake = new FakeMailer();
  const orig = fake.send.bind(fake);
  fake.send = async (a) => {
    await orig(a);
    const m = a.text.match(/https?:\/\/[^\s]+token=[\w-]+/);
    console.log(`\n[magic link for ${a.to}]\n  ${m?.[0] ?? '(no link parsed)'}\n`);
  };
  mailer = fake;
  console.log('using FakeMailer (RPOW_TEST_INBOX=true) — magic links print to this console');
} else {
  mailer = new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM);
}

const app = await buildApp({
  pool,
  mailer,
  config: {
    sessionSecret: env.SESSION_SECRET,
    magicLinkBaseUrl: env.MAGIC_LINK_BASE_URL,
    difficultyBits: env.DIFFICULTY_BITS,
    difficultyFloor: env.DIFFICULTY_FLOOR,
    mintEpochSize: env.MINT_EPOCH_SIZE,
    mintMaxSupply: env.MINT_MAX_SUPPLY,
    signingPrivateKeyHex: env.RPOW_SIGNING_PRIVATE_KEY_HEX,
    signingPublicKeyHex: env.RPOW_SIGNING_PUBLIC_KEY_HEX,
    webOrigin: env.WEB_ORIGIN,
    extraOrigins,
    secureCookies: env.NODE_ENV === 'production',
  },
});
await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info(`rpow3 server listening on :${env.PORT}`);

// Drain in-memory request counters into Postgres on a 30s timer. This
// drives the public /stats page; see metrics.ts for the loss/scale model.
const stopFlush = startMetricsFlush(pool, 30_000);
const shutdown = async (sig: string) => {
  app.log.info(`received ${sig}, draining metrics and closing`);
  await stopFlush();
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
