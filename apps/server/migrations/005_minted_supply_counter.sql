-- /mint runs `count(*) FROM tokens WHERE parent_token_id IS NULL` inside an
-- advisory lock to enforce the 21M cap. As the table grows past hundreds
-- of thousands of rows, that count dominates lock-hold time and limits
-- mint throughput to a few per second under load.
--
-- Replace it with a maintained counter row. /mint atomically increments
-- with a predicate (value < cap) — single-statement, ~1ms — which both
-- enforces the cap and updates the count.

CREATE TABLE IF NOT EXISTS app_counters (
  name  TEXT   PRIMARY KEY,
  value BIGINT NOT NULL
);

INSERT INTO app_counters (name, value)
SELECT 'minted_supply', count(*) FROM tokens WHERE parent_token_id IS NULL
ON CONFLICT (name) DO NOTHING;
