-- Daily OpenTimestamps anchor of the canvas state.
--
-- Every UTC midnight, the server serializes the canonical billboard
-- state, hashes it with SHA-256, submits the digest to one or more
-- public OTS calendar pools, and stores the returned receipt as
-- ots_proof_blob. That receipt eventually upgrades to include a path
-- into a Bitcoin block header (the calendar batches digests into one
-- on-chain transaction, typically every ~hour). After upgrade, the
-- bitcoin_block_height/_hash columns are filled in.
--
-- The blob is the binary content of the standard `.ots` file format
-- and is downloadable at GET /billboard/timestamps/:id.ots — anyone
-- with a Bitcoin node and the `ots` CLI can independently verify a
-- given snapshot existed by a given date, forever.

CREATE TABLE IF NOT EXISTS canvas_timestamps (
  id                   BIGSERIAL PRIMARY KEY,
  snapshot_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  state_sha256         BYTEA NOT NULL,
  slot_count           INTEGER NOT NULL DEFAULT 0,
  total_rpow_burned    BIGINT NOT NULL DEFAULT 0,
  ots_proof_blob       BYTEA,
  ots_calendar_url     TEXT,
  bitcoin_block_height INTEGER,
  bitcoin_block_hash   BYTEA,
  upgraded_at          TIMESTAMPTZ,
  -- A free-text status while the proof is still pending or upgrading,
  -- e.g. "submitted", "calendar_unreachable: <err>", "upgraded".
  status               TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS canvas_timestamps_snapshot_idx ON canvas_timestamps(snapshot_at DESC);
