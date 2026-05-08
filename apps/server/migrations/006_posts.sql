-- The Wall: spend 1 RPOW to post a public message. Hashcash-as-stamps —
-- Finney called them "Reusable Proofs of Work" but in practice nobody
-- reused them. The Wall reuses the proof for its 1997 hashcash purpose:
-- pay-to-post. Burned tokens cannot be transferred or unburned. Each post
-- references the burned token so anyone can audit-walk the Wall back to
-- the mint event.
--
-- Note on the supply cap: burning does NOT free a mint slot. The 21M cap
-- counts lifetime mint events, not circulating supply. Same semantics as
-- Bitcoin's coinbase cap.

ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_state_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_state_check
  CHECK (state IN ('VALID','INVALIDATED','BURNED'));

CREATE TABLE IF NOT EXISTS posts (
  id              UUID PRIMARY KEY,
  author_email    TEXT NOT NULL,
  token_id        UUID NOT NULL UNIQUE REFERENCES tokens(id),
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 280),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author_email);
