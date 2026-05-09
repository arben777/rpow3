// Helpers for the custodial Lightning sub-ledger.
//
// The single source of truth is `ln_ledger_entries`. Every credit/debit
// is one row there; balance/total counters in `ln_user_balances` are
// kept in sync within the same transaction. Callers must invoke these
// helpers from inside an already-open transaction (PoolClient).
//
// For invariants:
//   * No row writes a negative balance; the CHECK constraint on
//     ln_user_balances.balance_msat enforces this. If a debit would
//     drop us below zero, the UPDATE fails with a CHECK violation —
//     we surface that as an INSUFFICIENT_BALANCE_SATS to the caller.
//   * Atomicity is the caller's responsibility (we don't BEGIN/COMMIT).
//
// All amounts are msat. 1 sat = 1000 msat. 1% rake = floor(amount/100).

import type { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';

const HANDLE_ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateLnHandle(): string {
  // 8 chars, urlsafe-ish, ~3.4e12 namespace — collision odds are
  // negligible at any plausible user count, and the column has UNIQUE.
  let out = '';
  const bytes = randomBytes(16);
  for (let i = 0; i < 8; i++) {
    out += HANDLE_ALPHA[bytes[i]! % HANDLE_ALPHA.length];
  }
  return out;
}

export interface LedgerEntryArgs {
  user_email: string;
  delta_msat: number;
  reason: string;
  ref_invoice_hash?: Buffer;
  ref_slot_id?: number;
  ref_history_id?: number;
  ref_payout_id?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Apply a credit (positive delta) or debit (negative delta) to a user.
 * Updates ln_user_balances + inserts the journal entry.
 *
 * Throws on insufficient balance (Postgres CHECK constraint surface).
 */
export async function applyLedger(c: PoolClient, a: LedgerEntryArgs): Promise<void> {
  if (a.delta_msat === 0) return;
  // Update the balance and the in/out totals atomically.
  const isCredit = a.delta_msat > 0;
  const result = await c.query(
    `UPDATE ln_user_balances
       SET balance_msat = balance_msat + $1,
           total_in_msat  = total_in_msat  + $2,
           total_out_msat = total_out_msat + $3,
           updated_at = now()
     WHERE user_email = $4`,
    [
      a.delta_msat,
      isCredit ? a.delta_msat : 0,
      isCredit ? 0 : -a.delta_msat,
      a.user_email,
    ],
  );
  if (result.rowCount === 0) {
    throw new Error(`applyLedger: no ln_user_balances row for ${a.user_email}`);
  }
  await c.query(
    `INSERT INTO ln_ledger_entries
       (user_email, delta_msat, reason, ref_invoice_hash, ref_slot_id, ref_history_id, ref_payout_id, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      a.user_email,
      a.delta_msat,
      a.reason,
      a.ref_invoice_hash ?? null,
      a.ref_slot_id ?? null,
      a.ref_history_id ?? null,
      a.ref_payout_id ?? null,
      a.metadata ? JSON.stringify(a.metadata) : null,
    ],
  );
}

export async function ensureLnUserBalance(c: PoolClient, email: string): Promise<{ handle: string }> {
  // Try insert with random handle, retry on (extremely improbable) collision.
  for (let i = 0; i < 5; i++) {
    const handle = generateLnHandle();
    try {
      const r = await c.query<{ ln_address_handle: string }>(
        `INSERT INTO ln_user_balances (user_email, ln_address_handle)
         VALUES ($1, $2)
         ON CONFLICT (user_email) DO UPDATE SET updated_at = ln_user_balances.updated_at
         RETURNING ln_address_handle`,
        [email, handle],
      );
      return { handle: r.rows[0]!.ln_address_handle };
    } catch (e: any) {
      if (e?.code === '23505') continue; // unique violation, retry
      throw e;
    }
  }
  throw new Error('ensureLnUserBalance: handle collision exhausted');
}

/** Compute rake (msat) given an amount and rake bps (100 = 1.00%). */
export function rakeOf(amount_msat: number, bps: number): number {
  return Math.floor((amount_msat * bps) / 10_000);
}
