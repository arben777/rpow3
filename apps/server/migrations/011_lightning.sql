-- Internal Lightning sub-ledger.
--
-- The project runs ONE phoenixd Lightning node and acts as a custodial
-- bookkeeper for users. Each email-verified user gets a row in
-- ln_user_balances with a randomly-assigned 8-char handle that resolves
-- as <handle>@<domain> via LNURL-pay (LUD-06 / LUD-16).
--
-- Every credit/debit is journaled in ln_ledger_entries — the balance row
-- is the running cache, the entries table is the truth. Outbound payouts
-- (cash-out) live in ln_payouts and transition through PENDING →
-- SUCCEEDED|FAILED as phoenixd reports back. The 1% protocol rake from
-- takeovers and outbound payouts is recorded in protocol_rake_ledger
-- (kept separate from user balances so we can sweep it cleanly).

CREATE TABLE IF NOT EXISTS ln_user_balances (
  user_email         TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  balance_msat       BIGINT NOT NULL DEFAULT 0 CHECK (balance_msat >= 0),
  ln_address_handle  TEXT UNIQUE NOT NULL,
  ln_address_renamed BOOLEAN NOT NULL DEFAULT FALSE,
  total_in_msat      BIGINT NOT NULL DEFAULT 0,
  total_out_msat     BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ln_user_balances_handle_idx ON ln_user_balances(ln_address_handle);

CREATE TABLE IF NOT EXISTS ln_ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  user_email   TEXT NOT NULL REFERENCES users(email),
  delta_msat   BIGINT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN
                ('LN_PAYMENT_RECEIVED','LN_PAYMENT_SENT','LN_FEE',
                 'BILLBOARD_TAKEOVER_CREDIT','BILLBOARD_TAKEOVER_DEBIT',
                 'BILLBOARD_RAKE','REDEEM_REFUND','MANUAL_ADJUST')),
  ref_invoice_hash BYTEA,
  ref_slot_id  BIGINT REFERENCES slots(id),
  ref_history_id BIGINT REFERENCES slot_history(id),
  ref_payout_id BIGINT,
  metadata_json JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ln_ledger_user_idx    ON ln_ledger_entries(user_email, created_at);
CREATE INDEX IF NOT EXISTS ln_ledger_invoice_idx ON ln_ledger_entries(ref_invoice_hash);
CREATE INDEX IF NOT EXISTS ln_ledger_slot_idx    ON ln_ledger_entries(ref_slot_id) WHERE ref_slot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ln_payouts (
  id                  BIGSERIAL PRIMARY KEY,
  user_email          TEXT NOT NULL REFERENCES users(email),
  destination         TEXT NOT NULL,
  amount_msat         BIGINT NOT NULL CHECK (amount_msat > 0),
  rake_msat           BIGINT NOT NULL DEFAULT 0,
  ln_fee_msat         BIGINT,
  state               TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (state IN ('PENDING','SUCCEEDED','FAILED')),
  phoenixd_payment_id TEXT,
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ln_payouts_user_idx  ON ln_payouts(user_email, created_at);
CREATE INDEX IF NOT EXISTS ln_payouts_state_idx ON ln_payouts(state) WHERE state = 'PENDING';

CREATE TABLE IF NOT EXISTS protocol_rake_ledger (
  id             BIGSERIAL PRIMARY KEY,
  source         TEXT NOT NULL CHECK (source IN ('TAKEOVER','REDEEM')),
  ref_history_id BIGINT REFERENCES slot_history(id),
  ref_payout_id  BIGINT REFERENCES ln_payouts(id),
  amount_msat    BIGINT NOT NULL CHECK (amount_msat > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rake_source_idx ON protocol_rake_ledger(source, created_at);

-- LNURL-pay invoices we issue have a unique externalId that maps back to
-- the user/handle. Phoenixd reports incoming payments with that externalId,
-- which we use to credit the right user. We persist issued invoices for
-- audit and for filling out the LUD-06 callback response.
CREATE TABLE IF NOT EXISTS ln_invoices (
  id                BIGSERIAL PRIMARY KEY,
  user_email        TEXT NOT NULL REFERENCES users(email),
  payment_hash      BYTEA NOT NULL UNIQUE,
  amount_msat       BIGINT NOT NULL CHECK (amount_msat > 0),
  description_hash  BYTEA,
  bolt11            TEXT NOT NULL,
  external_id       TEXT NOT NULL UNIQUE,
  state             TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING','PAID','EXPIRED','FAILED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ln_invoices_user_idx ON ln_invoices(user_email, created_at);
CREATE INDEX IF NOT EXISTS ln_invoices_external_id_idx ON ln_invoices(external_id);
