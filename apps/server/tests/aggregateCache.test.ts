import { describe, it, expect } from 'vitest';
import { makeCachedAggregate, AggregateUnavailableError } from '../src/aggregateCache.js';

function setup(opts: { ttlMs?: number; retryAfterMs?: number } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => { t += ms; };
  let calls = 0;
  let fail = false;
  let value = 1;
  const errors: unknown[] = [];
  const get = makeCachedAggregate<number>({
    ttlMs: opts.ttlMs ?? 1000,
    retryAfterMs: opts.retryAfterMs ?? 500,
    name: 'ledger',
    now,
    onError: (e) => errors.push(e),
    refresh: async () => {
      calls++;
      if (fail) throw new Error('canceling statement due to statement timeout');
      return value;
    },
  });
  return { get, advance, errors, calls: () => calls, setFail: (f: boolean) => { fail = f; }, setValue: (v: number) => { value = v; } };
}

describe('makeCachedAggregate', () => {
  it('refreshes once and serves from cache within ttl', async () => {
    const s = setup();
    expect(await s.get()).toBe(1);
    s.setValue(2);
    expect(await s.get()).toBe(1);
    expect(s.calls()).toBe(1);
  });

  it('coalesces concurrent cold requests behind one refresh', async () => {
    const s = setup();
    const [a, b, c] = await Promise.all([s.get(), s.get(), s.get()]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(s.calls()).toBe(1);
  });

  it('serves stale immediately after ttl and revalidates in the background', async () => {
    const s = setup({ ttlMs: 100 });
    expect(await s.get()).toBe(1);
    s.setValue(2);
    s.advance(150);
    // Stale body returned right away; refresh kicked off behind the scenes.
    expect(await s.get()).toBe(1);
    await new Promise(r => setTimeout(r, 0));
    expect(s.calls()).toBe(2);
    expect(await s.get()).toBe(2);
  });

  it('keeps serving the last good result when a refresh fails, and backs off', async () => {
    const s = setup({ ttlMs: 100, retryAfterMs: 500 });
    expect(await s.get()).toBe(1);
    s.setFail(true);
    s.advance(150);
    expect(await s.get()).toBe(1);          // stale served, refresh started
    await new Promise(r => setTimeout(r, 0)); // refresh fails
    expect(s.errors).toHaveLength(1);
    expect(s.calls()).toBe(2);
    // Within the backoff window no further DB attempts are made.
    s.advance(100);
    expect(await s.get()).toBe(1);
    await new Promise(r => setTimeout(r, 0));
    expect(s.calls()).toBe(2);
    // After the backoff the next request retries, and recovers.
    s.setFail(false); s.setValue(3);
    s.advance(500);
    expect(await s.get()).toBe(1);          // still stale on this call
    await new Promise(r => setTimeout(r, 0));
    expect(await s.get()).toBe(3);
    expect(s.calls()).toBe(3);
  });

  it('fails cold with a 503 and does not stampede the DB during backoff', async () => {
    const s = setup({ retryAfterMs: 500 });
    s.setFail(true);
    await expect(s.get()).rejects.toBeInstanceOf(AggregateUnavailableError);
    await expect(s.get()).rejects.toMatchObject({ statusCode: 503 });
    expect(s.calls()).toBe(1);
    s.advance(600);
    s.setFail(false);
    expect(await s.get()).toBe(1);
    expect(s.calls()).toBe(2);
  });
});
