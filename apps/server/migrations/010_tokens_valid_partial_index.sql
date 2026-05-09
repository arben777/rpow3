-- /stats does network-wide aggregates on every cache miss (≥60 s gap):
--   1. count(*) FROM tokens WHERE state='VALID'                  (live.circulating)
--   2. SELECT owner_email, count(*) FROM tokens
--      WHERE state='VALID' GROUP BY owner_email
--      ORDER BY count(*) DESC LIMIT 30                            (top miners)
--
-- The existing tokens_owner_state_idx (owner_email, state) is leading on
-- owner_email, so neither query can use it as a seek — Postgres falls
-- back to a full scan over every tokens row (VALID + INVALIDATED both).
-- Past a few hundred K rows that runs over the 5 s statement_timeout
-- (db.ts) and /stats starts 504-ing; the Railway logs show four
-- back-to-back "canceling statement due to statement timeout" entries
-- per cache-miss request.
--
-- A partial index on (owner_email) WHERE state='VALID' covers exactly
-- the rows /stats reads: smaller than the existing composite (excludes
-- every INVALIDATED row, of which there are many after lots of
-- transfers — each /send burns N old tokens to mint N new ones), and
-- already in owner_email order so the GROUP BY proceeds as a single
-- in-order GroupAggregate scan with no separate sort step.
--
-- statement_timeout is widened locally to 0 for this transaction so the
-- index build itself isn't killed by the same 5 s cap that's killing
-- the queries we're trying to fix. SET LOCAL is per-tx; the app-wide
-- cap resumes after commit.
--
-- Note: CREATE INDEX (non-CONCURRENTLY) takes a SHARE lock that blocks
-- writes for the duration of the build. On a multi-million-row tokens
-- table that may pause /mint and /send for several seconds during the
-- deploy. If that's not acceptable, run the equivalent
-- `CREATE INDEX CONCURRENTLY ...` by hand against the production DB
-- before merging — the IF NOT EXISTS makes the migration a no-op once
-- the index is already there.

SET LOCAL statement_timeout = 0;

CREATE INDEX IF NOT EXISTS tokens_owner_valid_idx
  ON tokens(owner_email)
  WHERE state = 'VALID';
