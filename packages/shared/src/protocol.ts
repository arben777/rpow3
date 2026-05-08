// Wire-format types used by both server and web.

export interface AuthRequestBody { email: string; turnstile_token?: string }
export interface AuthRequestResponse { ok: true; cooldown_seconds: number }

export interface MeResponse {
  email: string;
  balance: number;
  minted: number;
  sent: number;
  received: number;
  burned: number;
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
  type: 'mint' | 'send' | 'receive' | 'burn' | 'boost' | 'graveyard';
  amount: number;
  counterparty_email?: string;
  at: string; // iso8601
}
export type ActivityResponse = ActivityEntry[];

export interface LedgerResponse {
  total_minted: number;
  total_transferred: number;
  total_burned: number;
  circulating_supply: number;
  current_difficulty_bits: number;
  user_count: number;
}

export interface PostRequestBody {
  body: string;
  idempotency_key: string;
}
export interface PostSummary {
  id: string;
  author_email: string;
  /** null when the post has been graveyarded — body is wiped on kill. */
  body: string | null;
  token_id: string;
  created_at: string; // iso8601
  /** Total RPOW burned on this post (1 for the original + every boost). */
  stake: number;
  graveyard_at: string | null;
  graveyard_by_email: string | null;
  graveyard_stake: number | null;
}
export interface PostResponse { ok: true; post: PostSummary }
export type PostsResponse = PostSummary[];

export interface BoostRequestBody {
  amount: number;
  idempotency_key: string;
}
export interface BoostResponse {
  ok: true;
  post_id: string;
  new_stake: number;
  action_id: string;
}

export interface GraveyardRequestBody {
  idempotency_key: string;
}
export interface GraveyardResponse {
  ok: true;
  post_id: string;
  graveyard_stake: number;
  action_id: string;
}
