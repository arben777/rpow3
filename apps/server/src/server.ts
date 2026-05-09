import { createHmac } from 'node:crypto';
import { parseEnv } from './env.js';
import { createPool, runMigrations } from './db.js';
import { buildApp } from './buildApp.js';
import { ResendMailer, FakeMailer, type Mailer } from './mailer.js';
import { createImageStore } from './billboard/imageStorage.js';
import { PhoenixdClient } from './lightning/phoenixd.js';
import { startOtsCron } from './billboard/otsCron.js';
import { parseAdminEmails } from './admin.js';

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

const imageStore = createImageStore({
  backend: env.STORAGE_BACKEND,
  s3: env.STORAGE_BACKEND === 's3' ? {
    endpoint: requireEnv(env.STORAGE_S3_ENDPOINT, 'STORAGE_S3_ENDPOINT'),
    region: requireEnv(env.STORAGE_S3_REGION, 'STORAGE_S3_REGION'),
    bucket: requireEnv(env.STORAGE_S3_BUCKET, 'STORAGE_S3_BUCKET'),
    accessKeyId: requireEnv(env.STORAGE_S3_ACCESS_KEY_ID, 'STORAGE_S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv(env.STORAGE_S3_SECRET_ACCESS_KEY, 'STORAGE_S3_SECRET_ACCESS_KEY'),
    publicUrlBase: env.STORAGE_PUBLIC_URL_BASE,
  } : undefined,
});

const phoenixd = env.LIGHTNING_ENABLED
  ? new PhoenixdClient({
      url: env.PHOENIXD_URL,
      httpPassword: requireEnv(env.PHOENIXD_HTTP_PASSWORD, 'PHOENIXD_HTTP_PASSWORD'),
    })
  : null;

const otsCalendars = env.OTS_CALENDARS
  ? env.OTS_CALENDARS.split(',').map(s => ({ url: s.trim() })).filter(c => c.url.length > 0)
  : [];

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
    billboard: {
      rpowPerCell: env.RPOW_PER_CELL,
      rakeBps: env.RAKE_BPS,
      noListHoldHours: env.NO_LIST_HOLD_HOURS,
      perEmailOwnedCapCells: env.PER_EMAIL_OWNED_CAP_CELLS,
      lightningEnabled: env.LIGHTNING_ENABLED,
      storagePublicUrlBase: env.STORAGE_PUBLIC_URL_BASE ?? null,
      serverPublicUrl: env.MAGIC_LINK_BASE_URL,
    },
    lightning: {
      enabled: env.LIGHTNING_ENABLED,
      domain: env.LN_ADDRESS_DOMAIN,
      rakeBps: env.RAKE_BPS,
      maxBalanceMsat: env.LN_USER_MAX_BALANCE_MSAT,
      maxPayout24hMsat: env.LN_USER_MAX_PAYOUT_24H_MSAT,
      // Webhook secret derived from session secret so we don't need a
      // separate env. Phoenixd's webhook URL embeds this in the path.
      webhookSecret: deriveWebhookSecret(env.SESSION_SECRET),
    },
    moderation: {
      enabled: env.MODERATION_ENABLED,
      sightengineApiUser: env.SIGHTENGINE_API_USER,
      sightengineApiSecret: env.SIGHTENGINE_API_SECRET,
      safeBrowsingApiKey: env.SAFE_BROWSING_API_KEY,
    },
    admin: parseAdminEmails(env.ADMIN_EMAILS),
    imageStore,
    phoenixd,
  },
});

if (env.OTS_CRON_ENABLED) {
  if (otsCalendars.length === 0) {
    app.log.warn('OTS_CRON_ENABLED=true but OTS_CALENDARS empty — cron will run but produce status=calendars_disabled rows');
  }
  startOtsCron({ pool, log: app.log as any, calendars: otsCalendars });
  app.log.info('OTS daily cron started');
}

await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info(`rpow3 server listening on :${env.PORT}`);

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when storage / lightning is enabled`);
  return value;
}

function deriveWebhookSecret(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update('phoenixd-webhook').digest('hex').slice(0, 32);
}
