import { parseEnv } from './env.js';
import { createPool, runMigrations } from './db.js';
import { buildApp } from './buildApp.js';
import { ResendMailer } from './mailer.js';

const env = parseEnv();
const pool = createPool(env.DATABASE_URL);
await runMigrations(pool);

const mailer = new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM);

const app = await buildApp({
  pool,
  mailer,
  config: {
    sessionSecret: env.SESSION_SECRET,
    magicLinkBaseUrl: env.MAGIC_LINK_BASE_URL,
    difficultyBits: env.DIFFICULTY_BITS,
    difficultyFloor: env.DIFFICULTY_FLOOR,
    signingPrivateKeyHex: env.RPOW_SIGNING_PRIVATE_KEY_HEX,
    signingPublicKeyHex: env.RPOW_SIGNING_PUBLIC_KEY_HEX,
    webOrigin: env.WEB_ORIGIN,
  },
});
await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info(`rpow2 server listening on :${env.PORT}`);
