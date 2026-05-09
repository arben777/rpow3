import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import type { Mailer } from './mailer.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { challengeRoutes } from './routes/challenge.js';
import { mintRoutes } from './routes/mint.js';
import { sendRoutes } from './routes/send.js';
import { claimRoutes } from './routes/claim.js';
import { activityRoutes } from './routes/activity.js';
import { ledgerRoutes } from './routes/ledger.js';
import { statsRoutes } from './routes/stats.js';
import { billboardRoutes, type BillboardConfig } from './routes/billboard.js';
import { lightningRoutes, type LightningConfig } from './routes/lightning.js';
import { adminModerationRoutes } from './routes/adminModeration.js';
import {
  createImageStore, type ImageStore,
} from './billboard/imageStorage.js';
import { type ModerationConfig } from './billboard/moderation.js';
import { PhoenixdClient } from './lightning/phoenixd.js';
import { parseAdminEmails, type AdminConfig } from './admin.js';

export interface AppConfig {
  sessionSecret: string;
  magicLinkBaseUrl: string;
  difficultyBits: number;
  difficultyFloor: number;
  mintEpochSize: number;
  mintMaxSupply: number;
  signingPrivateKeyHex: string;
  signingPublicKeyHex: string;
  webOrigin: string;
  /** Optional additional origins permitted by CORS (e.g. https://stats.rpow3.com). */
  extraOrigins?: string[];
  secureCookies: boolean;

  // ── Billboard / Lightning extras ─────────────────────────────────────
  billboard: BillboardConfig;
  lightning: LightningConfig;
  moderation: ModerationConfig;
  admin: AdminConfig;
  imageStore: ImageStore;
  phoenixd: PhoenixdClient | null;
}

export interface BuildAppOptions {
  test?: boolean;
  pool: Pool;
  mailer: Mailer;
  config: AppConfig;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    mailer: Mailer;
    config: AppConfig;
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.test ? false : { level: 'info' },
    // Disable per-request access logging at any tier. Each request emits
    // *two* info-level log lines (incoming + completed), and at viral
    // scale (~7k miners polling /challenge, /mint, /me, /ledger) that's
    // tens of thousands of lines per minute — well above Railway's log
    // ingest cap, which then drops batches and yells at us about it.
    // Errors and startup logs still flow through; we just stop logging
    // every successful 200. If you ever need per-request tracing for
    // debugging, flip this to opts.test for the duration of the run.
    disableRequestLogging: true,
    // Honor X-Forwarded-For across the Railway+Cloudflare proxy chain so
    // req.ip is the real client. Without this, req.ip is the internal proxy
    // address and the per-IP rate limit on /auth/request is useless.
    // Safe on Railway: containers only receive traffic through Railway's
    // edge, itself fronted by Cloudflare on api.rpow3.com.
    trustProxy: true,
    // Bigger body limit so claims with 256 KB base64-encoded images can
    // come through without 413. Base64 inflates by ~4/3, plus JSON
    // overhead — 1 MiB is a safe ceiling that still rejects arbitrary
    // JSON payloads.
    bodyLimit: 1 * 1024 * 1024,
  });

  app.decorate('pool', opts.pool);
  app.decorate('mailer', opts.mailer);
  app.decorate('config', opts.config);

  await app.register(cookie, { secret: opts.config.sessionSecret });
  // Allow the main web origin plus any additional origins (e.g. the
  // stats.rpow3.com subdomain). Pass a Set to @fastify/cors so unknown
  // origins fail closed; we don't want to wildcard while credentials are on.
  const allowed = new Set<string>([opts.config.webOrigin, ...(opts.config.extraOrigins ?? [])]);
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin requests and curl/server-to-server have no Origin header.
      // Browsers always set it on cross-origin XHR/fetch.
      if (!origin) return cb(null, true);
      cb(null, allowed.has(origin));
    },
    credentials: true,
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(challengeRoutes);
  await app.register(mintRoutes);
  await app.register(sendRoutes);
  await app.register(claimRoutes);
  await app.register(activityRoutes);
  await app.register(ledgerRoutes);
  await app.register(statsRoutes);
  await app.register((a) => billboardRoutes(a, {
    imageStore: opts.config.imageStore,
    moderationCfg: opts.config.moderation,
    cfg: opts.config.billboard,
  }));
  await app.register((a) => lightningRoutes(a, {
    cfg: opts.config.lightning,
    phoenixd: opts.config.phoenixd,
  }));
  await app.register((a) => adminModerationRoutes(a, {
    admins: opts.config.admin,
  }));

  app.get('/.well-known/rpow-pubkey.pem', async (_req, reply) => {
    const pubDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(app.config.signingPublicKeyHex, 'hex'),
    ]);
    const b64 = pubDer.toString('base64').match(/.{1,64}/g)!.join('\n');
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
    reply.header('content-type', 'application/x-pem-file').send(pem);
  });

  if (process.env.RPOW_TEST_INBOX === 'true') {
    app.get('/test/last-link/:email', async (req, reply) => {
      const email = decodeURIComponent((req.params as { email: string }).email).toLowerCase();
      const last = (app.mailer as any).lastTo?.(email);
      if (!last) return reply.code(404).send({ error: 'NO_LINK', message: `no magic link for ${email}` });
      const m = (last.text as string).match(/https?:\/\/[^\s]+token=[\w-]+/);
      if (!m) return reply.code(404).send({ error: 'NO_LINK', message: 'link not parseable' });
      const q = req.query as Record<string, string>;
      if (q.json === '1') return { link: m[0] };
      return reply.redirect(m[0], 302);
    });
  }

  return app;
}

// Re-exported so tests / callers can build their own AppConfig without
// reaching into deeply-nested module paths.
export { createImageStore, parseAdminEmails };
