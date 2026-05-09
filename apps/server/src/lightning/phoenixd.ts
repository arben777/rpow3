// phoenixd HTTP client.
//
// phoenixd (https://phoenix.acinq.co/server) exposes a small REST API on
// 127.0.0.1:9740. We talk to it for:
//   - createInvoice (BOLT11 invoice with amount, description, externalId)
//   - payInvoice    (cash-out via BOLT11)
//   - payLnAddress  (cash-out via username@host)
//   - getBalance    (channel balance / fee credit)
//   - getInfo       (sanity / health)
//
// Auth: HTTP Basic with empty username and the http-password from
// phoenixd.conf. We pass the password via the PHOENIXD_HTTP_PASSWORD env
// var.
//
// Production sets LIGHTNING_ENABLED=true and PHOENIXD_URL +
// PHOENIXD_HTTP_PASSWORD. Tests / dev leave LIGHTNING_ENABLED=false and
// the routes return 503 LIGHTNING_DISABLED — the client below is never
// instantiated in that path.

export interface PhoenixdConfig {
  url: string;
  httpPassword: string;
  fetchImpl?: typeof fetch;
}

export interface CreateInvoiceArgs {
  amountSat: number;
  description?: string;
  descriptionHash?: Buffer;
  externalId: string;
  expirySeconds?: number;
}

export interface CreatedInvoice {
  amountSat: number;
  paymentHash: string; // hex
  serialized: string;  // BOLT11
}

export interface PayInvoiceArgs {
  invoice: string;
  amountSat?: number; // for zero-amount invoices
}
export interface PaidInvoice {
  paymentId: string;
  paymentHash: string;
  paymentPreimage: string;
  recipientAmountSat: number;
  routingFeeSat: number;
}

export interface PayLnAddressArgs {
  address: string;
  amountSat: number;
  message?: string;
}

export interface PhoenixdInfo {
  nodeId: string;
  channels: unknown[];
  version?: string;
  chain?: string;
}

export interface PhoenixdBalance {
  balanceSat: number;
  feeCreditSat: number;
}

export class PhoenixdClient {
  private fetchImpl: typeof fetch;
  constructor(private cfg: PhoenixdConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`:${this.cfg.httpPassword}`).toString('base64');
  }

  private async post(path: string, body: Record<string, string>): Promise<any> {
    const url = `${this.cfg.url.replace(/\/+$/, '')}${path}`;
    const form = new URLSearchParams(body);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      body: form,
      headers: {
        authorization: this.authHeader(),
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`phoenixd ${path}: HTTP ${res.status}: ${text.slice(0, 400)}`);
    try { return text ? JSON.parse(text) : {}; } catch { return text; }
  }

  private async get(path: string): Promise<any> {
    const url = `${this.cfg.url.replace(/\/+$/, '')}${path}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { authorization: this.authHeader() },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`phoenixd ${path}: HTTP ${res.status}: ${text.slice(0, 400)}`);
    try { return text ? JSON.parse(text) : {}; } catch { return text; }
  }

  async getInfo(): Promise<PhoenixdInfo> { return this.get('/getinfo'); }
  async getBalance(): Promise<PhoenixdBalance> { return this.get('/getbalance'); }

  async createInvoice(a: CreateInvoiceArgs): Promise<CreatedInvoice> {
    const body: Record<string, string> = {
      amountSat: String(a.amountSat),
      externalId: a.externalId,
    };
    if (a.descriptionHash) body.descriptionHash = a.descriptionHash.toString('hex');
    else if (a.description) body.description = a.description;
    if (a.expirySeconds) body.expirySeconds = String(a.expirySeconds);
    const r = await this.post('/createinvoice', body);
    return {
      amountSat: Number(r.amountSat ?? a.amountSat),
      paymentHash: String(r.paymentHash),
      serialized: String(r.serialized),
    };
  }

  async payInvoice(a: PayInvoiceArgs): Promise<PaidInvoice> {
    const body: Record<string, string> = { invoice: a.invoice };
    if (a.amountSat) body.amountSat = String(a.amountSat);
    const r = await this.post('/payinvoice', body);
    return {
      paymentId: String(r.paymentId),
      paymentHash: String(r.paymentHash),
      paymentPreimage: String(r.paymentPreimage),
      recipientAmountSat: Number(r.recipientAmountSat ?? r.sent ?? 0),
      routingFeeSat: Number(r.routingFeeSat ?? r.fees ?? 0),
    };
  }

  async payLnAddress(a: PayLnAddressArgs): Promise<PaidInvoice> {
    const body: Record<string, string> = {
      address: a.address,
      amountSat: String(a.amountSat),
    };
    if (a.message) body.message = a.message;
    const r = await this.post('/paylnaddress', body);
    return {
      paymentId: String(r.paymentId),
      paymentHash: String(r.paymentHash ?? ''),
      paymentPreimage: String(r.paymentPreimage ?? ''),
      recipientAmountSat: Number(r.recipientAmountSat ?? r.sent ?? 0),
      routingFeeSat: Number(r.routingFeeSat ?? r.fees ?? 0),
    };
  }

  /** Look up a single incoming payment by external_id (paginated). */
  async findIncomingByExternalId(externalId: string): Promise<{ paymentHash: string; receivedSat: number } | null> {
    const r = await this.get(`/payments/incoming?externalId=${encodeURIComponent(externalId)}`);
    if (!Array.isArray(r) || r.length === 0) return null;
    const p = r[0]!;
    return { paymentHash: String(p.paymentHash), receivedSat: Number(p.receivedSat ?? 0) };
  }
}
