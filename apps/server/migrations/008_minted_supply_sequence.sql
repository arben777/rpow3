-- Replace app_counters.minted_supply hot row with a Postgres sequence.
--
-- Migration 005 introduced a maintained-counter row to replace count(*) in
-- the cap check. That removed the count(*) cost but reintroduced it as
-- *row-level lock contention*: every /mint and /claim ran
--   UPDATE app_counters SET value = value + 1 WHERE name='minted_supply'
-- which serialized all concurrent writers behind one row. Under viral
-- load (~250 mints/sec) the queue grew faster than it drained, mints
-- piled up, and the 5s statement_timeout started cancelling them
-- ("canceling statement due to statement timeout while locking tuple
-- (9,93) in relation app_counters"). Excess WAL from the doomed-but-
-- retried updates also pushed checkpoints from a few seconds to 80–170s.
--
-- Postgres sequences are designed for exactly this case: nextval() uses
-- a separate, in-memory lock manager, doesn't dirty data pages, and
-- doesn't participate in MVCC, so concurrent calls never block each
-- other. We use the returned value as both the supply counter and the
-- cap check (one atomic op: nextval, then compare to cap).
--
-- Tradeoff: sequences don't roll back. A mint tx that nextval()s and
-- then aborts "burns" that slot. With rare aborts that's a handful of
-- slots over the lifetime of a 21M cap — harmless.

CREATE SEQUENCE IF NOT EXISTS minted_supply_seq AS BIGINT MINVALUE 1;

-- Seed the sequence to the current minted count so the cap is preserved
-- across the migration. setval(seq, n, true) makes the next nextval()
-- return n+1; setval(seq, 1, false) makes the next nextval() return 1.
SELECT setval(
  'minted_supply_seq',
  GREATEST(1, COALESCE((SELECT value FROM app_counters WHERE name='minted_supply'), 0)),
  COALESCE((SELECT value FROM app_counters WHERE name='minted_supply'), 0) > 0
);

-- Drop the old row so nothing accidentally reads/writes it. Leave the
-- table itself in place in case future counters are added.
DELETE FROM app_counters WHERE name='minted_supply';
