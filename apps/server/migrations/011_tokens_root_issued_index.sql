-- /ledger and /stats both count "root" tokens (parent_token_id IS NULL):
--   count(*) FROM tokens WHERE parent_token_id IS NULL                 (total minted)
--   count(*) FROM tokens WHERE parent_token_id IS NULL
--     AND issued_at > now() - interval '30 minutes'                     (mint rate)
--   SELECT issued_at FROM tokens WHERE parent_token_id IS NULL
--     ORDER BY issued_at ASC OFFSET n LIMIT 1                           (last adjustment)
--
-- None of the existing indexes lead on parent_token_id or issued_at, so
-- every one of these is a sequential scan over the whole tokens table.
-- In production that now takes longer than the 5 s statement_timeout
-- (db.ts), so /ledger returns
--   {"code":"57014","message":"canceling statement due to statement timeout"}
-- on every request, and the eight parallel doomed scans it fires each
-- time tie up pool connections that /auth and /mint need.
--
-- A partial index on issued_at restricted to root tokens serves all three
-- shapes: count(*) becomes an index-only scan over a much smaller
-- structure, the 30-minute window becomes a tight range scan, and the
-- OFFSET query walks the index in order.
--
-- statement_timeout is widened for this transaction so the build itself
-- is not killed by the app-wide 5 s cap (same approach as migration 010).
--
-- Note: CREATE INDEX (non-CONCURRENTLY) holds a SHARE lock that blocks
-- writes on tokens for the duration of the build. On a very large table
-- that pauses /mint and /send for the build time during the deploy. To
-- avoid that, run this by hand against production before deploying:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS tokens_root_issued_idx
--     ON tokens(issued_at) WHERE parent_token_id IS NULL;
-- IF NOT EXISTS then makes the migration a no-op.

SET LOCAL statement_timeout = 0;

CREATE INDEX IF NOT EXISTS tokens_root_issued_idx
  ON tokens(issued_at)
  WHERE parent_token_id IS NULL;
