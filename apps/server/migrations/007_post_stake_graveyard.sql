-- Stake-ranked wall + graveyard.
--
-- Each post starts with stake=1 (the original burn). Anyone can BOOST a
-- post by burning N more RPOW; stake += N. The wall feed sorts by stake
-- DESC so the most-burned posts rise to the top.
--
-- Anyone can also GRAVEYARD a post by burning exactly 2 × current_stake.
-- The post is deleted forever: body is set NULL, graveyard_* fields are
-- recorded, and the post no longer appears in the wall feed. Once
-- graveyarded, a post cannot be boosted or re-killed.
--
-- The whole system is deflationary: every interaction destroys tokens
-- and burns count toward the 21M cap (mint slots are not freed).

ALTER TABLE posts ADD COLUMN IF NOT EXISTS stake INT NOT NULL DEFAULT 1
  CHECK (stake >= 1);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS graveyard_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS graveyard_by_email TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS graveyard_stake INT
  CHECK (graveyard_stake IS NULL OR graveyard_stake > 0);

-- Drop the original NOT NULL on body — graveyarding wipes it.
ALTER TABLE posts ALTER COLUMN body DROP NOT NULL;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_body_check;
ALTER TABLE posts ADD CONSTRAINT posts_body_check
  CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 280);

-- Hot path: feed query is `WHERE graveyard_at IS NULL ORDER BY stake DESC, created_at DESC`.
CREATE INDEX IF NOT EXISTS posts_stake_idx
  ON posts(stake DESC, created_at DESC) WHERE graveyard_at IS NULL;

-- Boost / graveyard events. The original post's burn is tracked in
-- posts.token_id (migration 006) — only the secondary actions live here.
CREATE TABLE IF NOT EXISTS post_actions (
  id              UUID PRIMARY KEY,
  post_id         UUID NOT NULL REFERENCES posts(id),
  actor_email     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('boost','graveyard')),
  amount          INT NOT NULL CHECK (amount > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS post_actions_post_idx
  ON post_actions(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS post_actions_actor_idx
  ON post_actions(actor_email, created_at DESC);
