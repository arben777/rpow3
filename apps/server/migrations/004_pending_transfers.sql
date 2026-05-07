-- Pending transfers: when a sender sends to an email that has no rpow2 account.
-- Tokens are invalidated on the sender side immediately; the recipient receives
-- an email with a one-time claim link. On claim, an account is auto-created and
-- `amount` fresh tokens are minted to the recipient.

CREATE TABLE IF NOT EXISTS pending_transfers (
  id UUID PRIMARY KEY,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  claim_token_hash BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS pending_transfers_claim_token_hash_idx
  ON pending_transfers(claim_token_hash);

CREATE INDEX IF NOT EXISTS pending_transfers_recipient_idx
  ON pending_transfers(recipient_email, claimed_at);

CREATE INDEX IF NOT EXISTS pending_transfers_sender_idx
  ON pending_transfers(sender_email, claimed_at);
