import type { Pool } from 'pg';

/**
 * Tally per-request counters in memory and flush them to Postgres on a
 * timer. This drives the public /stats page (top traffic sources,
 * endpoint share, client mix).
 *
 * Why in-memory + periodic flush instead of writing on every request:
 * /challenge alone runs into the millions of hits per day. A row write
 * per request would dominate the database. Buffering 30s of deltas and
 * UPSERTing them as one batch reduces that to a few small statements
 * per replica per minute — invisible against ledger/mint traffic.
 *
 * Loss model: if a replica crashes between flushes we lose at most ~30s
 * of counter increments. These are display-only stats; that's fine.
 */

type MetricType = 'endpoint' | 'client' | 'source';

interface Delta {
  count: number;
  lastClient?: string;
}

const buf: Record<MetricType, Map<string, Delta>> = {
  endpoint: new Map(),
  client: new Map(),
  source: new Map(),
};

function bump(type: MetricType, key: string, lastClient?: string) {
  const m = buf[type];
  const cur = m.get(key);
  if (cur) {
    cur.count += 1;
    if (lastClient) cur.lastClient = lastClient;
  } else {
    m.set(key, { count: 1, lastClient });
  }
}

/** Mask an IPv4 to /16 ("a.***.***.d") or shorten an IPv6 for display. */
export function maskIp(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  if (ip.includes(':')) {
    const segs = ip.split(':').filter(Boolean);
    if (segs.length === 0) return ip;
    const head = segs[0]!;
    const tail = segs[segs.length - 1]!.slice(-4);
    return `${head}:***:${tail}`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  return `${parts[0]}.***.***.${parts[3]}`;
}

/** Map a raw User-Agent to a coarse client label shown on the stats page. */
export function classifyClient(ua: string | undefined | null): string {
  if (!ua) return 'unknown';
  const u = ua.toLowerCase();
  // Order matters — longer/specific patterns first so e.g. "Colab GPU" wins
  // over a generic "GPU miner" match.
  if (u.includes('colab')) return 'Colab GPU';
  if (u.includes('miner-max') || u.includes('max-miner') || u.includes('maxminer')) return 'Max miner';
  if (u.includes('rust')) return 'Rust miner';
  if (u.includes('local-gpu') || u.includes('localgpu')) return 'Local GPU';
  if (u.includes('native-pool') || u.includes('nativepool')) return 'Native pool';
  if (u.includes('auth-miner') || u.includes('authminer')) return 'Auth miner';
  if (u.includes('cli-miner') || u.includes('climiner')) return 'CLI miner';
  if (u.includes('go-http') || u.includes('go-client') || /\bgo\//.test(u)) return 'Go client';
  if (u.includes('python') || u.includes('aiohttp') || u.includes('httpx')) return 'Python';
  if (u.includes('curl')) return 'curl';
  if (u.includes('axios')) return 'axios';
  if (u.includes('reqwest')) return 'reqwest';
  if (u.includes('java/') || u.includes('okhttp')) return 'Java';
  if (u.includes('node-fetch') || u.includes('undici') || u.includes('node.js') || /\bnode\b/.test(u)) {
    return 'Node.js';
  }
  if (u.includes('gpu')) return 'GPU miner';
  if (u.includes('miner')) return 'Other miner';
  if (u.includes('edg/') || u.includes('edge')) return 'Edge';
  if (u.includes('chrome')) return 'Chrome';
  if (u.includes('firefox')) return 'Firefox';
  if (u.includes('safari')) return 'Safari';
  if (u.includes('mozilla')) return 'Browser';
  return 'Other';
}

export interface RecordOpts {
  endpoint: string;
  ip: string | undefined;
  userAgent: string | undefined;
}

/** Hot path. Called from the Fastify onResponse hook for every request. */
export function recordRequest({ endpoint, ip, userAgent }: RecordOpts): void {
  const client = classifyClient(userAgent);
  bump('endpoint', endpoint);
  bump('client', client);
  bump('source', maskIp(ip), client);
}

/**
 * Drain the in-memory deltas and UPSERT them into request_metrics. Safe to
 * call concurrently with new recordRequest() calls — we swap the buffer
 * atomically before the network round trip so any new increments land in
 * the next flush.
 */
export async function flushMetrics(pool: Pool): Promise<void> {
  const drained: Record<MetricType, Map<string, Delta>> = {
    endpoint: buf.endpoint,
    client: buf.client,
    source: buf.source,
  };
  buf.endpoint = new Map();
  buf.client = new Map();
  buf.source = new Map();

  const types: MetricType[] = ['endpoint', 'client', 'source'];
  for (const type of types) {
    const m = drained[type];
    if (m.size === 0) continue;
    const keys: string[] = [];
    const counts: number[] = [];
    const lastClients: (string | null)[] = [];
    for (const [k, d] of m) {
      keys.push(k);
      counts.push(d.count);
      lastClients.push(d.lastClient ?? null);
    }
    // unnest unpacks the parallel arrays into a 3-column virtual table.
    // ON CONFLICT adds the delta to the existing count and refreshes
    // last_client when the new value isn't null.
    await pool.query(
      `INSERT INTO request_metrics (metric_type, key, count, last_client, updated_at)
       SELECT $1, k, c, lc, now()
       FROM unnest($2::text[], $3::bigint[], $4::text[]) AS t(k, c, lc)
       ON CONFLICT (metric_type, key) DO UPDATE
         SET count = request_metrics.count + EXCLUDED.count,
             last_client = COALESCE(EXCLUDED.last_client, request_metrics.last_client),
             updated_at = now()`,
      [type, keys, counts, lastClients],
    );
  }
}

/**
 * Start a periodic flush. Returns a stop function; call it on shutdown to
 * drain the final buffer and clear the interval.
 */
export function startMetricsFlush(pool: Pool, intervalMs = 30_000): () => Promise<void> {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await flushMetrics(pool);
    } catch (e) {
      // Swallow — stats are best-effort and we don't want a transient
      // DB error to crash the process.
      // eslint-disable-next-line no-console
      console.error('[metrics] flush failed', e);
    }
  };
  const handle = setInterval(tick, intervalMs);
  // Don't keep the event loop alive solely for the flush timer.
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
  return async () => {
    stopped = true;
    clearInterval(handle);
    try {
      await flushMetrics(pool);
    } catch {
      /* ignore on shutdown */
    }
  };
}

/** Test-only: clear the in-memory buffer. */
export function _resetMetricsBufferForTests(): void {
  buf.endpoint = new Map();
  buf.client = new Map();
  buf.source = new Map();
}
