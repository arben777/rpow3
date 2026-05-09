import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url(),
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().email().or(z.string().regex(/^[^@<>]+<[^@<>]+@[^@<>]+>$/)),
  SESSION_SECRET: z.string().min(32),
  MAGIC_LINK_BASE_URL: z.string().url(),
  RPOW_SIGNING_PRIVATE_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  RPOW_SIGNING_PUBLIC_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  DIFFICULTY_BITS: z.coerce.number().int().min(4).max(40).default(28),
  DIFFICULTY_FLOOR: z.coerce.number().int().min(4).max(40).default(20),
  MINT_EPOCH_SIZE: z.coerce.number().int().positive().default(1_000_000),
  MINT_MAX_SUPPLY: z.coerce.number().int().positive().default(21_000_000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  // Comma-separated list of additional CORS origins. Used to allow the
  // public stats subdomain (e.g. https://stats.rpow3.com) without
  // widening the main web app's policy.
  EXTRA_WEB_ORIGINS: z.string().optional(),
  TURNSTILE_SECRET: z.string().optional(),

  // ── Billboard ────────────────────────────────────────────────────────
  /** Email domain advertised for LN addresses, e.g. "rpow3.com". */
  LN_ADDRESS_DOMAIN: z.string().min(1).default('rpow3.com'),
  /** Comma-separated list of admin emails (case-insensitive). */
  ADMIN_EMAILS: z.string().optional(),
  /** RPOW burned per 10×10 cell. */
  RPOW_PER_CELL: z.coerce.number().int().positive().default(100),
  /** Protocol rake on every Lightning sat that flows through, in basis points. 100 = 1.00%. */
  RAKE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
  /** Anti-flip: hold time before a freshly-claimed/taken-over slot can be listed. */
  NO_LIST_HOLD_HOURS: z.coerce.number().int().min(0).default(24),
  /** Per-email cap: max simultaneously OWNED cells. */
  PER_EMAIL_OWNED_CAP_CELLS: z.coerce.number().int().positive().default(100),

  // ── Image storage ────────────────────────────────────────────────────
  /** "memory" (in-process; default for dev/test) or "s3" (Backblaze B2 via S3 API). */
  STORAGE_BACKEND: z.enum(['memory', 's3']).default('memory'),
  STORAGE_S3_ENDPOINT: z.string().optional(),
  STORAGE_S3_REGION: z.string().optional(),
  STORAGE_S3_BUCKET: z.string().optional(),
  STORAGE_S3_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Optional public CDN base, e.g. "https://cdn.rpow3.com". When unset we serve via /billboard/image/:slot/v:version. */
  STORAGE_PUBLIC_URL_BASE: z.string().optional(),

  // ── Moderation ───────────────────────────────────────────────────────
  /** When false, all uploads are auto-approved (dev/test). */
  MODERATION_ENABLED: z.coerce.boolean().default(false),
  SIGHTENGINE_API_USER: z.string().optional(),
  SIGHTENGINE_API_SECRET: z.string().optional(),
  SAFE_BROWSING_API_KEY: z.string().optional(),

  // ── Lightning (phoenixd) ─────────────────────────────────────────────
  /** When false, all /ln/* endpoints return LIGHTNING_DISABLED. */
  LIGHTNING_ENABLED: z.coerce.boolean().default(false),
  PHOENIXD_URL: z.string().url().default('http://127.0.0.1:9740'),
  PHOENIXD_HTTP_PASSWORD: z.string().optional(),
  /** Hard ceiling on a single user's balance (msat). 10M sats = 10_000_000_000 msat. */
  LN_USER_MAX_BALANCE_MSAT: z.coerce.number().int().positive().default(10_000_000_000),
  /** Hard ceiling on a user's outbound payouts in any rolling 24h (msat). 1M sats. */
  LN_USER_MAX_PAYOUT_24H_MSAT: z.coerce.number().int().positive().default(1_000_000_000),

  // ── OpenTimestamps ───────────────────────────────────────────────────
  /** Comma-separated calendar pool URLs. Empty disables stamping. */
  OTS_CALENDARS: z.string().default('https://a.pool.opentimestamps.org,https://b.pool.opentimestamps.org'),
  /** When true, run the daily stamp + upgrade cron in-process. */
  OTS_CRON_ENABLED: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof Schema>;

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`invalid env: ${msg}`);
  }
  return parsed.data;
}
