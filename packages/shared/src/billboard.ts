// Wire-format types for the billboard + Lightning sub-system.

/** A 1000×1000 px canvas in 100×100 cells (each cell is 10×10 px). */
export const CANVAS_CELL_PX = 10;
export const CANVAS_DIM_CELLS = 100;
export const CANVAS_DIM_PX = CANVAS_CELL_PX * CANVAS_DIM_CELLS;
/** Cells × RPOW = 100 × 100 = 10,000 max if/when canvas is full. */
export const RPOW_PER_CELL = 100;

export type SlotState = 'OWNED' | 'MOD_HIDDEN' | 'EMPTY';

/** Compact slot row used by /billboard/grid. */
export interface SlotGridEntry {
  slot_id: number;
  /** cell coords (0..99) */
  cell_x: number;
  cell_y: number;
  cell_w: number;
  cell_h: number;
  state: SlotState;
  /** Masked email of current owner, e.g. "b****@gmail.com". null when empty/hidden. */
  owner_handle_masked: string | null;
  image_url: string | null;
  click_url: string | null;
  /** Sats price if currently listed, else null. */
  listing_sats: number | null;
  pending_review: boolean;
  total_rpow_burned: number;
  version: number;
}

export interface SlotHistoryEntry {
  event:
    | 'CLAIM'
    | 'EDIT'
    | 'LIST'
    | 'UNLIST'
    | 'TAKEOVER'
    | 'ABANDON'
    | 'MOD_HIDDEN'
    | 'MOD_RESTORED';
  actor_masked: string | null;
  prior_owner_masked: string | null;
  rpow_burned: number;
  sats_paid: number;
  sats_rake: number;
  at: string; // iso8601
}

export interface SlotDetail extends SlotGridEntry {
  text_caption: string | null;
  hover_tooltip: string | null;
  no_list_until: string | null;
  /** When `image_url` was last updated. */
  updated_at: string;
  takeover_count: number;
  history: SlotHistoryEntry[];
}

export interface BillboardClaimRequest {
  cell_x: number;
  cell_y: number;
  cell_w: number;
  cell_h: number;
  /** Base64-encoded image bytes. ≤256KB raw. */
  image_b64: string;
  /** Source content type ("image/png", "image/jpeg", "image/webp"). */
  image_content_type: 'image/png' | 'image/jpeg' | 'image/webp';
  click_url: string;
  text_caption?: string;
  hover_tooltip?: string;
}

export interface BillboardClaimResponse {
  slot_id: number;
  state: SlotState;
  pending_review: boolean;
  image_url: string | null;
  rpow_burned: number;
}

export interface BillboardEditRequest {
  slot_id: number;
  image_b64?: string;
  image_content_type?: 'image/png' | 'image/jpeg' | 'image/webp';
  click_url?: string;
  text_caption?: string;
  hover_tooltip?: string;
}
export interface BillboardEditResponse {
  slot_id: number;
  version: number;
  pending_review: boolean;
  image_url: string | null;
}

export interface BillboardListRequest {
  slot_id: number;
  listing_sats: number;
}
export interface BillboardListResponse {
  slot_id: number;
  listing_sats: number;
}
export interface BillboardUnlistRequest { slot_id: number }
export interface BillboardUnlistResponse { slot_id: number }
export interface BillboardTakeoverRequest { slot_id: number }
export interface BillboardTakeoverResponse {
  slot_id: number;
  new_owner_email: string;
  sats_paid: number;
  sats_rake: number;
  seller_credit_sats: number;
}
export interface BillboardAbandonRequest {
  slot_id: number;
  /** Required confirmation phrase to guard against accidents. */
  confirm: string;
}
export interface BillboardAbandonResponse { slot_id: number }

export interface BillboardReportRequest {
  reason: 'NSFW' | 'CSAM' | 'MALWARE' | 'COPYRIGHT' | 'IMPERSONATION' | 'OTHER';
  notes?: string;
}

export interface BillboardSummary {
  cells_claimed: number;
  cells_total: number; // 10000
  pixels_claimed: number;
  total_rpow_burned: number;
  slots_listed: number;
  rake_msat_total: number;
  config: {
    rpow_per_cell: number;
    rake_bps: number; // 100 = 1.00%
    canvas_dim_cells: number;
    cell_px: number;
    no_list_hold_hours: number;
    per_email_owned_cap_cells: number;
    lightning_enabled: boolean;
    moderation_enabled: boolean;
  };
}

// ── Lightning (custodial sub-ledger) ────────────────────────────────────

export interface LnBalanceResponse {
  balance_msat: number;
  ln_address: string; // e.g. "abc12345@rpow3.com"
  ln_address_handle: string;
  ln_address_renamed: boolean;
  total_in_msat: number;
  total_out_msat: number;
  payouts_24h_msat: number;
  /** Configured ceilings (msat). */
  max_balance_msat: number;
  max_payout_24h_msat: number;
  enabled: boolean;
}

export interface LnRedeemRequest {
  /** Either a BOLT11 invoice or a Lightning address (foo@bar.com). */
  destination: string;
  amount_msat: number;
}
export interface LnRedeemResponse {
  payout_id: number;
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED';
}

export interface LnPayout {
  payout_id: number;
  destination: string;
  amount_msat: number;
  rake_msat: number;
  ln_fee_msat: number | null;
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  failure_reason: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface LnRenameRequest { handle: string }
export interface LnRenameResponse { handle: string; ln_address: string }

// ── Canvas timestamps ──────────────────────────────────────────────────

export interface CanvasTimestamp {
  id: number;
  snapshot_at: string;
  state_sha256_hex: string;
  slot_count: number;
  total_rpow_burned: number;
  ots_calendar_url: string | null;
  bitcoin_block_height: number | null;
  bitcoin_block_hash_hex: string | null;
  upgraded_at: string | null;
  status: string;
  ots_proof_url: string | null;
}
export type CanvasTimestampsResponse = CanvasTimestamp[];
