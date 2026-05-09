import type {
  AuthRequestBody, AuthRequestResponse, MeResponse,
  ChallengeResponse, MintRequestBody, MintResponse,
  SendRequestBody, SendResponse, ActivityResponse, LedgerResponse, ApiError,
  StatsResponse,
  BillboardClaimRequest, BillboardClaimResponse,
  BillboardEditRequest, BillboardEditResponse,
  BillboardListRequest, BillboardListResponse,
  BillboardUnlistRequest, BillboardUnlistResponse,
  BillboardTakeoverRequest, BillboardTakeoverResponse,
  BillboardAbandonRequest, BillboardAbandonResponse,
  BillboardSummary, SlotGridEntry, SlotDetail,
  BillboardReportRequest,
  LnBalanceResponse, LnRedeemRequest, LnRedeemResponse,
  LnPayout, LnRenameRequest, LnRenameResponse,
  CanvasTimestampsResponse,
} from '@rpow/shared';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method, credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: ApiError;
    try { err = await res.json(); } catch { err = { error: 'INTERNAL', message: res.statusText }; }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * Resolve an absolute URL the front-end can use to load slot images, even
 * when the server returns a path like "/billboard/image/123/v1" (which is
 * the no-CDN dev path). When the server has STORAGE_PUBLIC_URL_BASE set,
 * the URL it returns is already absolute and we pass it through.
 */
export function resolveImageUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/')) return `${BASE}${u}`;
  return `${BASE}/${u}`;
}

export const api = {
  authRequest: (b: AuthRequestBody) => call<AuthRequestResponse>('POST', '/auth/request', b),
  me: () => call<MeResponse>('GET', '/me'),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  challenge: () => call<ChallengeResponse>('POST', '/challenge'),
  mint: (b: MintRequestBody) => call<MintResponse>('POST', '/mint', b),
  send: (b: SendRequestBody) => call<SendResponse>('POST', '/send', b),
  activity: () => call<ActivityResponse>('GET', '/activity'),
  ledger: () => call<LedgerResponse>('GET', '/ledger'),
  stats: () => call<StatsResponse>('GET', '/stats'),

  // Billboard
  billboardSummary: () => call<BillboardSummary>('GET', '/billboard/summary'),
  billboardGrid: () => call<SlotGridEntry[]>('GET', '/billboard/grid'),
  billboardSlot: (id: number) => call<SlotDetail>('GET', `/billboard/slot/${id}`),
  billboardClaim: (b: BillboardClaimRequest) => call<BillboardClaimResponse>('POST', '/billboard/claim', b),
  billboardEdit: (b: BillboardEditRequest) => call<BillboardEditResponse>('POST', '/billboard/edit', b),
  billboardList: (b: BillboardListRequest) => call<BillboardListResponse>('POST', '/billboard/list', b),
  billboardUnlist: (b: BillboardUnlistRequest) => call<BillboardUnlistResponse>('POST', '/billboard/unlist', b),
  billboardTakeover: (b: BillboardTakeoverRequest) => call<BillboardTakeoverResponse>('POST', '/billboard/takeover', b),
  billboardAbandon: (b: BillboardAbandonRequest) => call<BillboardAbandonResponse>('POST', '/billboard/abandon', b),
  billboardReport: (id: number, b: BillboardReportRequest) =>
    call<{ ok: true }>('POST', `/billboard/slot/${id}/report`, b),
  billboardTimestamps: () => call<CanvasTimestampsResponse>('GET', '/billboard/timestamps'),
  billboardStateHash: () => call<{ state_sha256_hex: string; slot_count: number; total_rpow_burned: number; generated_at: string }>('GET', '/billboard/state-hash'),

  // Lightning
  lnBalance: () => call<LnBalanceResponse>('GET', '/ln/balance'),
  lnRename: (b: LnRenameRequest) => call<LnRenameResponse>('POST', '/ln/rename', b),
  lnRedeem: (b: LnRedeemRequest) => call<LnRedeemResponse>('POST', '/ln/redeem', b),
  lnPayouts: () => call<LnPayout[]>('GET', '/ln/payouts'),
  lnPayout: (id: number) => call<LnPayout>('GET', `/ln/payout/${id}`),
};
