-- Persistent counters for the public /stats page.
--
-- We tally three things per request: which endpoint was hit, which client
-- (classified from User-Agent), and which source IP (masked to /16). Every
-- replica keeps in-memory deltas and flushes them via UPSERT every ~30s,
-- so a single row aggregates traffic across replicas and survives restarts.
-- Reads come from this table only — the stats endpoint never touches the
-- in-memory map — which keeps the per-replica view consistent.
--
-- Cardinality bounds: ~10 endpoints, ~20 client classes, and one row per
-- masked IP /16 (~tens of thousands worst case). The (metric_type, count
-- DESC) index makes the top-N reads cheap.

CREATE TABLE IF NOT EXISTS request_metrics (
  metric_type TEXT NOT NULL,
  key         TEXT NOT NULL,
  count       BIGINT NOT NULL DEFAULT 0,
  last_client TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_type, key)
);

CREATE INDEX IF NOT EXISTS request_metrics_type_count_idx
  ON request_metrics(metric_type, count DESC);
