# RPOW2 — Design Spec

**Status:** Draft v1
**Date:** 2026-05-07
**Owner:** fred
**Domain:** rpow2.com
**Tagline:** *A tribute to the original RPOW by Hal Finney.*

A faithful modern recreation of Hal Finney's Reusable Proofs of Work (2004), shipped as a public web product at **rpow2.com** with companion iOS/Android app. Users sign in via magic link, mine RPOW tokens by solving hashcash-style proofs of work, and transfer tokens to other users by email. The server is the trusted issuer/registry: it signs tokens, prevents double-spend, and re-issues on transfer.

The product is positioned explicitly as a tribute. The original RPOW system was Hal Finney's 2004 prototype of a reusable proof-of-work currency — a direct intellectual ancestor of Bitcoin. RPOW2 keeps the protocol's core idea (mine a hashcash POW, exchange it for a server-signed reusable token, transfer by reissuance) and modernizes the surface (modern crypto, email identity, web/mobile clients).

## Goals

- Stay faithful to the spirit of Finney's RPOW: server-issued, server-signed, server-tracked tokens; reissuance on transfer; transparent ledger.
- Ship as a real product on a domain like `rpow2.com` with magic-link auth, real email delivery, and a mobile app.
- Retro terminal aesthetic — monospace, no graphics — that signals the project's lineage.
- Honest difficulty: mining one token takes ~30 s on a current MacBook Pro, ~60–90 s on a phone. Difficulty is uniform across devices.

## Non-Goals (v1)

- Variable-value tokens or token splitting/merging (Finney supported this; we keep value=1 for simplicity).
- Bearer-string token export. Tokens live on our server; transfer happens via email-keyed accounts.
- Public API for third parties.
- Any monetary value, fiat conversion, or trading mechanic.
- Username/handle layer. Email is the only identity.
- Two-factor auth or password login.

## Core Protocol

### Identity

- Account = email address.
- Auth = magic link (15-minute expiry, single-use).
- Auto-register on first valid magic-link click — no separate signup flow.
- Sessions = HTTP-only signed cookie containing a 30-day refresh JWT.

### Mining flow

1. Logged-in client posts `POST /api/challenge`.
2. Server returns `{ challenge_id, nonce_prefix, difficulty_bits, expires_at }`. `nonce_prefix` is unique per challenge; `expires_at` ~5 min out; one active challenge per session.
3. Client iterates a `solution_nonce` integer, computing `SHA-256(nonce_prefix || solution_nonce_le_bytes)`. The target is **≥ `difficulty_bits` trailing zero bits** in the hash output.
4. On finding a solution, client posts `POST /api/mint { challenge_id, solution_nonce }`.
5. Server verifies the hash, marks the challenge claimed, mints one fresh RPOW token, credits sender's wallet, and returns the new token record.

### Transfer flow

`POST /api/send { recipient_email, amount, idempotency_key }`. Inside one DB transaction:

1. **Verify recipient account exists.** If `recipient_email` is not a registered user, fail immediately with `404 RECIPIENT_NOT_FOUND`. No tokens are reserved or invalidated. The UI shows `error: recipient has no rpow2 account`.
2. Verify sender has ≥ `amount` valid tokens. Otherwise fail `400 INSUFFICIENT_BALANCE`.
3. Mark N sender tokens as `INVALIDATED` (state retained for audit, original rows preserved).
4. Mint N fresh tokens owned by recipient. Each new token carries `parent_token_id` = the invalidated token it was reissued from.

The `idempotency_key` (UUID supplied by client) is unique per transfer; replays return the original result (including the original failure if the first call rejected).

### Token shape

```json
{
  "id": "uuid",
  "owner_email_hash": "sha256(email)",
  "value": 1,
  "issued_at": "iso8601",
  "parent_token_id": "uuid | null",
  "server_sig": "ed25519(...)"
}
```

The signed payload is mostly for verifiability — a third party can fetch the public key and validate authenticity. Source of truth remains the server's ledger.

### Difficulty

- Target: ~30 s for one token on a modern (M-series) MacBook with WASM SHA-256 in a Web Worker.
- Concretely ~28 trailing zero bits at launch; tunable from a single config.
- A server-side **difficulty floor** prevents the value from ever dropping below a configured minimum even if hash rates explode.
- Uniform across web and mobile; phones simply take longer.
- Difficulty and total minted are exposed live on the public ledger page.

## UX (Retro Terminal)

### Aesthetic

- Monospace everywhere. `IBM Plex Mono` (web font) on web; `Menlo`/`Courier New` system monospace on mobile.
- No graphics, no logos, no icons. ASCII for borders, separators, and emphasis.
- Default theme: off-white on near-black. Toggleable amber-on-black and green-on-black themes.
- Subtle CRT scanline effect available but off by default.
- Single-column layouts, ~80-char visual width, fixed-width type metrics.
- Every page renders the tagline `a tribute to the original rpow by hal finney` in the top header strip, and the public ledger and footer link to Hal Finney's original RPOW announcement (cypherpunks archive) for context.

### Pages

- **Login** — email input, `[ SEND LINK ]` button, status line.
- **Wallet (home)** — balance, mint/sent/received counters, primary actions.
- **Mine** — live HASHES / RATE / ELAPSED / STATUS counters, abort key.
- **Send** — recipient + amount form, confirm.
- **Activity** — recent mints, sends, receipts.
- **Ledger** (public, no login) — total minted, total transferred, circulating supply, current difficulty.

### Interaction

- Mouse + keyboard parity. Buttons styled `[ MINE ]` are clickable AND respond to `M`.
- Letter shortcuts on every page; an `?` overlay shows the current key map.
- Animations limited to the mining counter and a single blinking cursor.

### Mobile-specific

- Native styling matches the terminal aesthetic using system monospace.
- Magic-link emails contain Universal/App Links so tapping in Mail.app routes into the app.
- Push notifications (Expo's free push) on incoming RPOW.

## Architecture

### Repo layout (npm workspaces monorepo)

```
rpow/
  package.json                 # workspaces root
  apps/
    server/                    # Node 22 + Fastify + TypeScript
      src/
        server.ts              # entry
        routes/                # auth, challenge, mint, send, ledger, me
        pow.ts                 # SHA-256 trailing-zero verifier, difficulty calc
        db.ts                  # Postgres pool + migration runner
        magic.ts               # magic-link issue/verify
        signing.ts             # Ed25519 keypair, token signing/verifying
        mailer.ts              # Resend client
        ratelimit.ts           # Fastify plugin config
      migrations/              # SQL files, applied on boot
      tests/                   # Vitest
    web/                       # Vite + React + TypeScript
      src/
        main.tsx               # React Router bootstrap
        pages/                 # Login, Wallet, Mine, Send, Activity, Ledger
        components/            # Panel (ASCII border), Button, Field, ThemeProvider
        miner-worker.ts        # Web Worker: SHA-256 mining loop (WASM)
        api.ts                 # fetch wrapper, types from shared
        theme.ts               # color tokens for the three themes
      public/                  # IBM Plex Mono webfont
      index.html
    mobile/                    # Expo (React Native) + TypeScript
      app/                     # Expo Router screens
      modules/sha256-miner/    # native module wrapping a tight SHA-256 mining loop
  packages/
    shared/                    # Types & constants used by all apps
      src/
        protocol.ts            # request/response shapes
        difficulty.ts          # shared difficulty math
  README.md
  .env.example
```

### Server stack

- **Fastify** (lightweight, fast, native TS) — single small process.
- **Postgres** via **Neon** (serverless free tier; pooler suits Fly).
- **Ed25519** server keypair stored in env. Public key served at `/.well-known/rpow-pubkey.pem` for public verifiability.
- **Sessions** via signed httpOnly cookie carrying a 30-day JWT.
- **Magic links**: 15-minute single-use tokens, hashed at rest.
- **Email**: Resend (free tier 100/day, 3k/month — sufficient for launch; upgradeable).

### Routes

- `POST /auth/request` — issue a magic link to an email.
- `GET  /auth/verify?token=...` — exchange magic-link token for session cookie; redirect to wallet.
- `POST /auth/logout` — clear session.
- `GET  /me` — current user, balance, counters.
- `POST /challenge` — request a mining challenge.
- `POST /mint` — submit a solved challenge, mint a token.
- `POST /send` — transfer tokens to another email.
- `GET  /activity` — recent activity for the logged-in user.
- `GET  /ledger` — public aggregate stats.
- `GET  /.well-known/rpow-pubkey.pem` — server public key.

### Database (Postgres)

```sql
users(
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

magic_links(
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

challenges(
  id UUID PRIMARY KEY,
  user_email TEXT NOT NULL,
  nonce_prefix BYTEA NOT NULL,
  difficulty_bits INT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ
);

tokens(
  id UUID PRIMARY KEY,
  owner_email TEXT NOT NULL,
  value INT NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('VALID','INVALIDATED')),
  issued_at TIMESTAMPTZ NOT NULL,
  invalidated_at TIMESTAMPTZ,
  parent_token_id UUID REFERENCES tokens(id),
  server_sig BYTEA NOT NULL
);
CREATE INDEX ON tokens(owner_email, state);

transfers(
  id UUID PRIMARY KEY,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  amount INT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```


### Web client

- React 18 + Vite + TypeScript.
- React Router for the page set.
- Mining inside a Web Worker that loads a small WASM SHA-256 implementation; ~3–5× faster than pure JS, sufficient for ~28-bit difficulty in ~30 s on M-series.
- Auth via cookie; magic-link landing route exchanges link for cookie and redirects.

### Mobile client

- Expo + React Native + TypeScript, Expo Router for navigation.
- A small native module (`modules/sha256-miner`) wraps a tight SHA-256 mining loop in C/Swift/Kotlin so we don't pay JS-bridge costs per hash.
- Universal Links / App Links so tapping a magic link in Mail.app opens the app logged in.
- Expo Push for incoming-RPOW notifications.

### Hosting

- Domain: `rpow2.com` (or similar). Cloudflare DNS + TLS.
- Server: **Fly.io** single small machine (256 MB) in one region, auto-deployed from `main` via GitHub Actions.
- DB: **Neon** Postgres free tier; connection string in Fly secrets.
- Email: **Resend**.
- Web: **Cloudflare Pages**, deployed on push.
- Mobile binaries: **Expo EAS Build**, distributed via TestFlight + Play Internal Testing pre-launch, then App Store + Play Store.

## Security & Abuse Mitigations

- **Magic-link request limits:**
  - 30-second cooldown per email, surfaced as a polite countdown rather than an error.
  - 30/hour per email, hourly reset (not rolling) so users can predict it.
  - 60/hour per IP — the actual anti-spam lever.
  - **Cloudflare Turnstile** on the request form.
  - No hard lockouts. The UI always tells the user when they can retry.
- **Magic links:** 15-minute expiry, single-use, hashed at rest.
- **Mining:** unique server-issued `nonce_prefix` per challenge, one active challenge per session, server-side difficulty floor.
- **Transfers:** atomic invalidate-and-reissue inside a DB transaction, idempotency key required.
- **No transfers to non-accounts:** sends to unregistered emails fail immediately, removing the "spam someone's balance" attack surface entirely.
- **Token signing:** every token is Ed25519-signed; pubkey published.
- **Audit chain:** `parent_token_id` lets anyone walk a token back to its mint event via the ledger.
- **Email:** outbound bounded by Resend's account limits.

## Testing

- **Unit (Vitest):** PoW verifier, difficulty math, token signing/verification, magic-link issue/verify, transfer invariants, idempotency.
- **Integration (Vitest + real Postgres in CI via Docker):** mint flow, send flow (success, insufficient balance, recipient-not-found), idempotency replays.
- **E2E (Playwright):** request magic link → intercept email in test mode → mine (test-mode difficulty=8) → send → verify recipient balance.
- **Mobile (Maestro):** login → mine → send happy path on iOS Simulator and Android Emulator.
- **Load (k6):** `/challenge` + `/mint` under a few dozen concurrent miners.

## Operations

- **Backups:** nightly `pg_dump` from Neon to Cloudflare R2.
- **Monitoring:** Fly's built-in metrics; alerts on 5xx rate and Resend bounces.
- **Logs:** structured JSON via `pino` — request, mint, send, magic-link events.
- **Secrets:** Fly secrets + GitHub Actions encrypted env. No secrets in repo.
- **Server keypair rotation:** documented runbook only in v1; no automated rotation yet.
- **Public observability:** `/ledger` page doubles as a transparency dashboard.

## Open Questions

- Email sender domain: needs DNS records (SPF, DKIM, DMARC via Resend) configured for `rpow2.com`.
- Native mobile mining module: build a custom Expo native module vs. pulling `react-native-quick-crypto` and wrapping a tight loop in JS — decided in implementation plan based on benchmarks.

## Out-of-Scope Reminders

The temptations to add:
- Variable-value tokens / splitting / merging — **no** in v1.
- Token export as bearer string — **no** in v1.
- Public API — **no** in v1.
- Fiat or trading — **never**.
