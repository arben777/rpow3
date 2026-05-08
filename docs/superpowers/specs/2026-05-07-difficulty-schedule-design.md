# Difficulty Schedule & 21M Supply Cap — Design

**Date:** 2026-05-07
**Status:** Spec, awaiting implementation plan

## Goal

Cap RPOW total supply at **21,000,000 tokens** by raising mining difficulty in lockstep with supply, modeled on (but not identical to) Bitcoin's halving epochs. Existing 1-token-per-challenge mining flow is unchanged; only the *required difficulty bits* and a new *hard cap check* are added.

## Schedule

Linear schedule: every 1,000,000 tokens minted, difficulty increases by 1 trailing-zero bit.

| Supply range (root tokens) | Difficulty bits |
| --- | --- |
| 0 – 999,999 | 25 |
| 1,000,000 – 1,999,999 | 26 |
| 2,000,000 – 2,999,999 | 27 |
| … | … |
| 20,000,000 – 20,999,999 | 45 |
| ≥ 21,000,000 | mints refused (hard cap) |

Each +1 bit doubles work per token, so time-per-million doubles each tier. The 21M ceiling is an asymptotic limit — practically unreachable, exactly per the Hal-Finney-tribute spirit.

Constants (in code):
```
MINT_BASE_BITS = 25
MINT_EPOCH_SIZE = 1_000_000
MINT_MAX_SUPPLY = 21_000_000
MINT_MAX_EPOCH = 20   // = MAX_SUPPLY / EPOCH_SIZE - 1
```

Defaults overridable via an `opts` argument so tests can drive boundaries with small numbers (e.g. `epochSize: 10, maxSupply: 21`).

## Architecture

One new pure module + minimal route changes. **No schema migration.** The existing `tokens` table where `parent_token_id IS NULL` already counts root mints — that's the supply oracle.

### New file: `apps/server/src/schedule.ts`

Pure functions, no I/O:

```ts
export interface ScheduleOpts {
  baseBits?: number;
  epochSize?: number;
  maxSupply?: number;
}

export function difficultyForSupply(mintedCount: number, opts?: ScheduleOpts): number;

export interface EpochInfo {
  epoch: number;             // 0-indexed, capped at MINT_MAX_EPOCH
  currentBits: number;       // difficulty for the current epoch
  nextMilestoneAt: number;   // supply level where difficulty next increases (or maxSupply when at last epoch)
  coinsToNext: number;       // nextMilestoneAt - mintedCount
  isCapped: boolean;         // mintedCount >= maxSupply
}

export function epochInfo(mintedCount: number, opts?: ScheduleOpts): EpochInfo;
```

`difficultyForSupply` returns `baseBits + min(floor(mintedCount / epochSize), maxEpoch)`. The `DIFFICULTY_FLOOR` env var still applies at the route layer — final difficulty = `max(floor, scheduleBits)`.

### Modified: `apps/server/src/routes/challenge.ts`

Replace the static-config difficulty with a supply-aware computation.

Current:
```ts
const difficulty = Math.max(app.config.difficultyFloor, app.config.difficultyBits);
```

New:
```ts
const { rows } = await app.pool.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL`
);
const minted = rows[0].n;
if (minted >= MINT_MAX_SUPPLY) {
  return reply.code(410).send({ error: 'SUPPLY_EXHAUSTED', message: '21M cap reached' });
}
const difficulty = Math.max(
  app.config.difficultyFloor,
  difficultyForSupply(minted, { baseBits: app.config.difficultyBits })
);
```

`difficulty` is then stamped onto the challenge row, exactly as today. **The user's mining work is locked at challenge issuance** — even if a milestone crosses while they mine, their submission is verified against the bits stamped on the challenge. (See "Race handling.")

### Modified: `apps/server/src/routes/mint.ts`

Inside the existing `withTx` block, after loading the challenge but before inserting the token:

```ts
// Serialize all mints on a single advisory lock so the cap check + insert is race-free.
await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_mint_supply'))`);

const { rows: supplyRows } = await c.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL`
);
if (supplyRows[0].n >= MINT_MAX_SUPPLY) {
  return { error: 'SUPPLY_EXHAUSTED' as const, message: '21M cap reached' };
}
// existing INSERT into tokens, UPDATE challenges SET claimed_at, signing, etc.
```

The challenge row's stamped `difficulty_bits` continues to drive `verifySolution` — no change there.

### Modified: `apps/server/src/routes/ledger.ts`

Additive fields, no breaking change. Read epoch info via `epochInfo(totalMinted)` and merge into the response:

```jsonc
{
  // existing
  "total_minted": 16903,
  "total_transferred": 0,
  "circulating_supply": 16887,
  "current_difficulty_bits": 25,
  "user_count": 130,

  // new
  "max_supply": 21000000,
  "epoch": 0,
  "epoch_size": 1000000,
  "next_milestone_at": 1000000,
  "coins_until_next_milestone": 983097,
  "next_difficulty_bits": 26,
  "is_capped": false
}
```

This lets the web UI render "X coins until next halving" without an extra endpoint.

## Race handling

**Goal:** never mint coin #21,000,001. Acceptable: a few coins overshoot epoch boundaries by a handful (because mining was started before the boundary crossed).

**Mechanism:** Postgres advisory transaction lock at the top of every `/mint` transaction (`pg_advisory_xact_lock(hashtext('rpow_mint_supply'))`). Held until `COMMIT`/`ROLLBACK`. All mints serialize on this single lock.

**Why advisory lock, not SERIALIZABLE:** advisory lock is a single hot lock with deterministic blocking semantics; SERIALIZABLE pushes retry logic into the caller. At observed peak ~50 req/s with `/mint` txn ~20ms, the lock is held ~30% of the time — fine. Revisit if sustained throughput exceeds ~100 mints/sec.

**Why not a counter table:** would require a migration, an initial backfill, and an extra UPDATE per mint. Same correctness, more moving parts. Skip until provably needed.

**Why no lock on `/challenge`:** the count read there is informational — used only to *stamp* the challenge's difficulty. If two concurrent challenges at a milestone boundary both stamp 25 bits, that's fine. The cap is enforced at `/mint`.

## Error handling

New error code: `SUPPLY_EXHAUSTED`.

- HTTP 410 Gone (matches existing `CHALLENGE_EXPIRED` precedent).
- Returned by `/challenge` (refusing to issue) and `/mint` (race-loser refusing to insert).
- Body: `{ "error": "SUPPLY_EXHAUSTED", "message": "21M cap reached" }`.

Web client handling: out of scope for this spec but listed as a follow-up — display "Supply cap reached" instead of the generic mining-failure path.

## Tests

TDD. Failing tests before implementation.

### Unit (`apps/server/tests/schedule.test.ts`, new)

Pure functions, no DB:

- `difficultyForSupply(0)` → 25
- `difficultyForSupply(999_999)` → 25
- `difficultyForSupply(1_000_000)` → 26
- `difficultyForSupply(2_500_000)` → 27
- `difficultyForSupply(20_999_999)` → 45
- `difficultyForSupply(21_000_000)` → 45 (clamped at `maxEpoch`; cap is enforced separately)
- `difficultyForSupply(0, { baseBits: 10, epochSize: 10, maxSupply: 21 })` → 10
- `difficultyForSupply(15, { baseBits: 10, epochSize: 10, maxSupply: 21 })` → 11
- `epochInfo(500_000)` → `{ epoch: 0, currentBits: 25, nextMilestoneAt: 1_000_000, coinsToNext: 500_000, isCapped: false }`
- `epochInfo(21_000_000)` → `{ ..., isCapped: true }`

### Integration (extend existing `apps/server/tests/`)

Use `opts: { baseBits: 4, epochSize: 10, maxSupply: 21 }` plumbed via `app.config` so boundaries can be hit quickly. (Existing `app.config.difficultyBits` becomes `baseBits`; `floor` continues to apply.)

- **Difficulty scales with supply:** seed 5 root tokens, hit `/challenge`, assert stamped `difficulty_bits = 4` (epoch 0). Seed 5 more (total 10), hit `/challenge`, assert `difficulty_bits = 5` (epoch 1).
- **Hard cap at /challenge:** seed 21 root tokens. `POST /challenge` returns 410 SUPPLY_EXHAUSTED.
- **Hard cap at /mint:** issue a challenge when supply is 20 (stamps low difficulty). Before submission, insert another root token directly (simulating a race). Submit `/mint` with valid solution → returns 410 SUPPLY_EXHAUSTED.
- **Concurrent /mint at boundary:** with supply at 20, fire 5 parallel `/mint` requests with valid solutions for distinct challenges. Exactly 1 succeeds; the other 4 return 410 SUPPLY_EXHAUSTED. (Validates the advisory lock serializes correctly.)

### Existing tests

Should pass unchanged. The current 16,903 root tokens are well under 1M, so default difficulty stays at 25.

## Rollout

- Single PR, deployed via the existing Fly pipeline. No feature flag.
- No DB migration. No data backfill.
- Existing 16,903 tokens grandfather in via the live `count(*)` — at deploy time, `floor(16903 / 1_000_000) = 0` so difficulty stays at 25 (matches today's behaviour).
- The cap is mathematically inactive until ~1M is approached.

## Out of scope

- **Frontend:** showing epoch progress, "next halving in X coins", or `SUPPLY_EXHAUSTED` UI. Captured as a follow-up ticket — the new `/ledger` fields make this a small, isolated UI change.
- **Counter-table optimization:** see Race handling.
- **Retroactive difficulty changes** for already-issued challenges: out of scope. A challenge stamped with 25 bits stays at 25 bits regardless of subsequent supply changes.
- **Difficulty schedule for transfers:** transfers don't mint root tokens (they create child tokens with a `parent_token_id`), so they don't count toward supply and aren't affected.
