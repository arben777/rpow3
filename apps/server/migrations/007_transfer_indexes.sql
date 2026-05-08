-- /me runs `sum(amount) FROM transfers WHERE sender_email=$1` and the
-- same on recipient_email on every wallet load. /activity runs both
-- predicates inside a UNION. Without these indexes Postgres falls back
-- to sequential scans of the entire transfers table on every request.
-- Once transfers grows past a few thousand rows that becomes the
-- dominant per-request DB cost. Both indexes are tiny (~text key +
-- ctid) and additive — safe to apply at any time.

CREATE INDEX IF NOT EXISTS transfers_sender_idx ON transfers(sender_email);
CREATE INDEX IF NOT EXISTS transfers_recipient_idx ON transfers(recipient_email);
