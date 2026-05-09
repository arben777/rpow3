import type {
  AuthRequestBody, AuthRequestResponse, MeResponse,
  ChallengeResponse, MintRequestBody, MintResponse,
  SendRequestBody, SendResponse, ActivityResponse, LedgerResponse, ApiError,
  StatsResponse,
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
};
