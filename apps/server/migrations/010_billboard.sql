-- The Billboard: a 1000×1000 px canvas in 100×100 cells (10×10 px each).
-- Cells are claimed by burning RPOW (100 RPOW per 10×10 cell), and resold
-- via Lightning sats with a 1% protocol rake. See docs/BILLBOARD.md.
--
-- Design notes:
--   * cell_x/cell_y/cell_w/cell_h are in CELL units, not pixels. A whole
--     1000×1000 canvas is 100×100 cells. (cell_x + cell_w) <= 100 and
--     (cell_y + cell_h) <= 100 by CHECK; w/h are >= 1.
--   * The bbox column is a generated geometric `box` covering the slot's
--     cells (inclusive corners). The EXCLUDE USING gist (bbox WITH &&)
--     constraint enforces the "no two non-EMPTY slots overlap" invariant
--     atomically inside Postgres — race-free under concurrent claims, no
--     app-level locking needed.
--   * On ABANDON we keep the row but flip state='EMPTY' and clear the
--     content fields. The exclusion constraint's WHERE filter ignores
--     EMPTY rows, so the same coordinates can be re-claimed later. The
--     row stays so slot_history entries (FK on slot_id) survive.
--   * No btree_gist needed — the EXCLUDE uses pure GiST on the box type.

CREATE TABLE IF NOT EXISTS slots (
  id            BIGSERIAL PRIMARY KEY,
  cell_x        SMALLINT NOT NULL CHECK (cell_x BETWEEN 0 AND 99),
  cell_y        SMALLINT NOT NULL CHECK (cell_y BETWEEN 0 AND 99),
  cell_w        SMALLINT NOT NULL CHECK (cell_w >= 1 AND cell_x + cell_w <= 100),
  cell_h        SMALLINT NOT NULL CHECK (cell_h >= 1 AND cell_y + cell_h <= 100),

  owner_email   TEXT REFERENCES users(email) ON DELETE SET NULL,
  state         TEXT NOT NULL DEFAULT 'OWNED'
                CHECK (state IN ('OWNED','MOD_HIDDEN','EMPTY')),

  image_object_key   TEXT,
  image_content_type TEXT,
  click_url          TEXT,
  text_caption       TEXT,
  hover_tooltip      TEXT,

  total_rpow_burned   INTEGER NOT NULL DEFAULT 0,
  listing_active      BOOLEAN NOT NULL DEFAULT FALSE,
  listing_sats        BIGINT,
  listing_set_at      TIMESTAMPTZ,
  pending_review      BOOLEAN NOT NULL DEFAULT FALSE,
  no_list_until       TIMESTAMPTZ,

  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  bbox          box GENERATED ALWAYS AS (
    box(point(cell_x, cell_y),
        point(cell_x + cell_w - 1, cell_y + cell_h - 1))
  ) STORED
);

ALTER TABLE slots
  DROP CONSTRAINT IF EXISTS slots_no_overlap;
ALTER TABLE slots
  ADD CONSTRAINT slots_no_overlap
  EXCLUDE USING gist (bbox WITH &&)
  WHERE (state <> 'EMPTY');

CREATE INDEX IF NOT EXISTS slots_owner_idx     ON slots(owner_email) WHERE state = 'OWNED';
CREATE INDEX IF NOT EXISTS slots_listing_idx   ON slots(listing_active) WHERE listing_active = TRUE;
CREATE INDEX IF NOT EXISTS slots_pending_idx   ON slots(pending_review) WHERE pending_review = TRUE;
CREATE INDEX IF NOT EXISTS slots_state_idx     ON slots(state);

-- ── slot_history ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS slot_history (
  id            BIGSERIAL PRIMARY KEY,
  slot_id       BIGINT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  event         TEXT NOT NULL CHECK (event IN
                  ('CLAIM','EDIT','LIST','UNLIST','TAKEOVER',
                   'ABANDON','MOD_HIDDEN','MOD_RESTORED')),
  actor_email       TEXT,
  prior_owner_email TEXT,
  rpow_burned   INTEGER NOT NULL DEFAULT 0,
  sats_paid     BIGINT NOT NULL DEFAULT 0,
  sats_rake     BIGINT NOT NULL DEFAULT 0,
  metadata_json JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slot_history_slot_idx ON slot_history(slot_id, created_at);
CREATE INDEX IF NOT EXISTS slot_history_actor_idx ON slot_history(actor_email, created_at);

-- ── moderation_events ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS moderation_events (
  id            BIGSERIAL PRIMARY KEY,
  slot_id       BIGINT NOT NULL REFERENCES slots(id),
  source        TEXT NOT NULL CHECK (source IN
                  ('AUTO_SIGHTENGINE','USER_REPORT','OPS_REVIEW','SAFE_BROWSING')),
  decision      TEXT CHECK (decision IN ('NO_ACTION','HIDE','RESTORE','CSAM','FLAG')),
  classifier_score JSONB,
  reporter_email TEXT,
  reporter_ip   TEXT,
  ops_email     TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_slot_idx ON moderation_events(slot_id, created_at);

-- ── tokens.invalidated_for_slot_id ──────────────────────────────────────
-- Audit-trail link from a burned RPOW token back to the billboard slot it
-- was burned for. Lets us answer "which exact mining sessions paid for
-- this slot" forever after.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS invalidated_for_slot_id BIGINT REFERENCES slots(id);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS invalidated_reason TEXT;
CREATE INDEX IF NOT EXISTS tokens_invalidated_for_slot_idx
  ON tokens(invalidated_for_slot_id)
  WHERE invalidated_for_slot_id IS NOT NULL;
