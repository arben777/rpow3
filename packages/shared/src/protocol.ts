// Wire-format types used by both server and web.

export interface AuthRequestBody { email: string; turnstile_token?: string }
export interface AuthRequestResponse { ok: true; cooldown_seconds: number }

export interface MeResponse {
  email: string;
  balance: number;
  minted: number;
  sent: number;
  received: number;
}

export interface ChallengeResponse {
  challenge_id: string;
  nonce_prefix: string; // hex
  difficulty_bits: number;
  expires_at: string;   // iso8601
}

export interface MintRequestBody {
  challenge_id: string;
  solution_nonce: string; // decimal string of u64
}
export interface MintResponse { token: TokenSummary }

export interface TokenSummary {
  id: string;
  value: number;
  issued_at: string;
}

export interface SendRequestBody {
  recipient_email: string;
  amount: number;
  idempotency_key: string;
}
export interface SendResponse {
  ok: true;
  transferred: number;
  recipient_email: string;
  transfer_id: string;
  /** True when the recipient had no rpow3 account; an email was sent for them to claim. */
  pending?: boolean;
}

export type ApiErrorCode =
  | 'RECIPIENT_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_SOLUTION'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_CLAIMED'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'INTERNAL';

export interface ApiError { error: ApiErrorCode; message: string; retry_after?: number }

export interface ActivityEntry {
  type: 'mint' | 'send' | 'receive';
  amount: number;
  counterparty_email?: string;
  at: string; // iso8601
}
export type ActivityResponse = ActivityEntry[];

export interface UserGrowthPoint {
  at: string;     // iso8601 5-minute bucket
  users: number;  // cumulative user count at that bucket
}

export interface LedgerResponse {
  total_minted: number;
  total_transferred: number;
  circulating_supply: number;
  current_difficulty_bits: number;
  user_count: number;
  // Schedule fields (already returned by server; previously omitted from this type).
  max_supply: number;
  epoch: number;
  epoch_size: number;
  next_milestone_at: number;
  coins_until_next_milestone: number;
  next_difficulty_bits: number;
  is_capped: boolean;
  // Growth + adjustment fields.
  user_growth: UserGrowthPoint[];
  /** Time it took the user count to most recently double, in seconds. null when total < 2. */
  doubling_seconds: number | null;
  /** ISO8601 of the very first user's created_at. null when no users. */
  first_signup_at: string | null;
  /** ISO8601 of the moment the last +1-bit bump landed (issued_at of the (epoch*1M)-th mint). null when still at base difficulty. */
  last_adjustment_at: string | null;
  /** Estimated seconds until the next +1-bit bump, based on the last 30m of mint activity. null when capped or no recent mints. */
  next_adjustment_eta_seconds: number | null;
  /** Mints per minute over the last 30 minutes. */
  mint_rate_per_minute: number;
}
