import { Resend } from 'resend';

export interface SendArgs { to: string; subject: string; html: string; text: string }
export interface Mailer { send(args: SendArgs): Promise<void> }

// Resend error names where retrying is pointless — bad payload or hard
// rejection that won't recover in milliseconds. `daily_quota_exceeded`
// resets at the day boundary, not within a backoff window.
const DETERMINISTIC_RESEND_FAILURES = new Set([
  'validation_error',
  'missing_required_field',
  'invalid_idempotency_key',
  'not_found',
  'daily_quota_exceeded',
]);

const RESEND_MAX_ATTEMPTS = 3;

export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string) {}
  async send(a: SendArgs): Promise<void> {
    // Retry transient Resend failures (rate_limit_exceeded,
    // internal_server_error, network blips). Without this, a single 429
    // or 5xx during /send rolls back the entire transfer transaction
    // and the user sees a failure they have to manually retry.
    //
    // Total backoff is capped tight because /send calls us from inside
    // an open DB transaction — Postgres' idle_in_transaction_session_timeout
    // (10 s, db.ts) will kill the connection if we sit too long. Three
    // attempts with 250 ms + 500 ms gaps adds ~750 ms of pure wait at
    // worst on top of the API round-trips.
    const c = new Resend(this.apiKey);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < RESEND_MAX_ATTEMPTS; attempt++) {
      try {
        const { error } = await c.emails.send({
          from: this.from, to: a.to, subject: a.subject, html: a.html, text: a.text,
        });
        if (!error) return;
        lastErr = error;
        if (error.name && DETERMINISTIC_RESEND_FAILURES.has(error.name)) break;
      } catch (e) {
        // SDK throws on network/timeout failures rather than returning
        // an error object — those are always worth retrying.
        lastErr = e;
      }
      if (attempt < RESEND_MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, 250 * (2 ** attempt)));
      }
    }
    const e = lastErr as { name?: string; message?: string } | null;
    const msg = e?.message ?? String(lastErr);
    const name = e?.name && e.name !== 'Error' ? ` (${e.name})` : '';
    throw new Error(`resend: ${msg}${name}`);
  }
}

export class FakeMailer implements Mailer {
  outbox: SendArgs[] = [];
  async send(a: SendArgs): Promise<void> { this.outbox.push(a); }
  lastTo(addr: string): SendArgs | undefined { return [...this.outbox].reverse().find(m => m.to === addr); }
}
