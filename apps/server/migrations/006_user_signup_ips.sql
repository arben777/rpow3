-- Track each user's signup IP. Side table so existing user rows are not
-- backfilled or modified — pre-existing users simply have no row here.
-- One row per email; the FIRST signup IP wins (later logins do not
-- overwrite). This is additive only; nothing in the existing schema is
-- changed or moved.

CREATE TABLE IF NOT EXISTS user_signup_ips (
  email        TEXT PRIMARY KEY REFERENCES users(email),
  ip_addr      TEXT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_signup_ips_ip_idx ON user_signup_ips(ip_addr);
CREATE INDEX IF NOT EXISTS user_signup_ips_recorded_at_idx ON user_signup_ips(recorded_at);
