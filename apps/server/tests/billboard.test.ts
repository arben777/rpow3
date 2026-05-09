import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp, type TestAppOverrides } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';
import { randomUUID } from 'node:crypto';

// 1×1 px PNG, valid magic + IDAT + IEND. Used as a tiny "real" image for
// the billboard claim flow. Sniffing only checks the magic bytes, so
// this is enough to pass validation in tests where moderation is off.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({
    method: 'POST', url: '/auth/request',
    payload: { email },
    headers: { 'content-type': 'application/json' },
  });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
  }
}

/** Bump the test cap so we can mint enough tokens to claim. */
async function expandSupply(ctx: Awaited<ReturnType<typeof makeTestApp>>, n: number) {
  // The default test config sets mintMaxSupply=21. For billboard tests we
  // need way more tokens. We bypass the mint loop by INSERTing fake tokens
  // directly; that's much faster and the difficulty still verifies for
  // non-billboard tests. We also advance the supply sequence so /mint
  // doesn't trip on the cap.
  await ctx.pool.query(`SELECT setval('minted_supply_seq', $1, true)`, [n]);
}

async function seedTokens(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  email: string,
  n: number,
) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(randomUUID());
  await ctx.pool.query(
    `INSERT INTO tokens (id, owner_email, value, state, server_sig)
     SELECT u, $1, 1, 'VALID', '\\x00' FROM unnest($2::uuid[]) AS u`,
    [email, ids],
  );
}

describe('billboard', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  async function setup(overrides: TestAppOverrides = {}) {
    // Lower per-cell cost so we don't have to mint thousands of tokens
    // in tests; default 100 → 4 RPOW/cell.
    return makeTestApp({ rpowPerCell: 4, ...overrides });
  }

  it('GET /billboard/summary returns config + counters', async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/billboard/summary' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.cells_total).toBe(10000);
    expect(body.cells_claimed).toBe(0);
    expect(body.config.rpow_per_cell).toBe(4);
    expect(body.config.canvas_dim_cells).toBe(100);
    expect(body.config.cell_px).toBe(10);
    expect(body.config.lightning_enabled).toBe(false);
  });

  it('claims a 1×1 cell and burns 4 RPOW', async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    await expandSupply(ctx, 1000);
    const cookie = await loginAs(ctx, 'a@x.com');
    await seedTokens(ctx, 'a@x.com', 4);

    const res = await ctx.app.inject({
      method: 'POST', url: '/billboard/claim',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        cell_x: 5, cell_y: 5, cell_w: 1, cell_h: 1,
        image_b64: TINY_PNG_B64, image_content_type: 'image/png',
        click_url: 'https://example.com/',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slot_id).toBeGreaterThan(0);
    expect(body.rpow_burned).toBe(4);
    expect(body.pending_review).toBe(false);

    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.balance).toBe(0);

    const grid = (await ctx.app.inject({ method: 'GET', url: '/billboard/grid' })).json();
    expect(grid).toHaveLength(1);
    expect(grid[0].cell_x).toBe(5);
    expect(grid[0].owner_handle_masked).toMatch(/a\*+@x\.com/);

    const summary = (await ctx.app.inject({ method: 'GET', url: '/billboard/summary' })).json();
    expect(summary.cells_claimed).toBe(1);
    expect(summary.total_rpow_burned).toBe(4);
  });

  it('rejects an overlapping claim with 409 SLOT_OVERLAP', async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    await expandSupply(ctx, 1000);
    const a = await loginAs(ctx, 'a@x.com');
    await seedTokens(ctx, 'a@x.com', 16);

    const first = await ctx.app.inject({
      method: 'POST', url: '/billboard/claim',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: {
        cell_x: 0, cell_y: 0, cell_w: 4, cell_h: 4,
        image_b64: TINY_PNG_B64, image_content_type: 'image/png',
        click_url: 'https://example.com/',
      },
    });
    expect(first.statusCode).toBe(201);

    const overlap = await ctx.app.inject({
      method: 'POST', url: '/billboard/claim',
      headers: { cookie: a, 'content-type': 'application/json' },
      payload: {
        cell_x: 2, cell_y: 2, cell_w: 4, cell_h: 4,
        image_b64: TINY_PNG_B64, image_content_type: 'image/png',
        click_url: 'https://example.com/',
      },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error).toBe('SLOT_OVERLAP');
  });

  it('rejects insufficient RPOW with 400 INSUFFICIENT_RPOW', async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    await expandSupply(ctx, 1000);
    const cookie = await loginAs(ctx, 'a@x.com');
    await seedTokens(ctx, 'a@x.com', 3); // need 4 for 1 cell

    const res = await ctx.app.inject({
      method: 'POST', url: '/billboard/claim',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        cell_x: 0, cell_y: 0, cell_w: 1, cell_h: 1,
        image_b64: TINY_PNG_B64, image_content_type: 'image/png',
        click_url: 'https://example.com/',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_RPOW');
  });

  it('rejects http:// URL', async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    await expandSupply(ctx, 1000);
    const cookie = await loginAs(ctx, 'a@x.com');
    await seedTokens(ctx, 'a@x.com', 4);

    const res = await ctx.app.inject({
      method: 'POST', url: '/billboard/claim',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        cell_x: 0, cell_y: 0, cell_w: 1, cell_h: 1,
        image_b64: TINY_PNG_B64, image_content_type: 'image/png',
        click_url: 'http://example.com/',
      },
    });
    expect(res.statusCode).toBe(400);
    // Either zod URL validation or moderateUrl can reject; both are fine.
    const body = res.json();
    expect(['BAD_REQUEST', 'URL_REJECTED']).toContain(body.error);
  });

  it('rejects mismatched image bytes', async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/billboard/claim',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        cell_x: 0, cell_y: 0, cell_w: 1, cell_h: 1,
        image_b64: Buffer.from('this is plain text not a png').toString('base64'),
        image_content_type: 'image/png',
        click_url: 'https://example.com/',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists, takes over (with stub phoenixd), and pays the rake', async () => {
    const ctx = await setup({ phoenixd: {} }); cleanup = ctx.cleanup;
    await expandSupply(ctx, 1000);

    const seller = await loginAs(ctx, 'seller@x.com');
    const buyer = await loginAs(ctx, 'buyer@x.com');
    await seedTokens(ctx, 'seller@x.com', 4);

    // Seller claims a 1×1 slot, then disable the cooldown so they can list immediately.
    const claimed = await ctx.app.inject({
      method: 'POST', url: '/billboard/claim',
      headers: { cookie: seller, 'content-type': 'application/json' },
      payload: {
        cell_x: 0, cell_y: 0, cell_w: 1, cell_h: 1,
        image_b64: TINY_PNG_B64, image_content_type: 'image/png',
        click_url: 'https://example.com/',
      },
    });
    const slotId = claimed.json().slot_id;

    // Listing requires no cooldown for fresh claims.
    const listed = await ctx.app.inject({
      method: 'POST', url: '/billboard/list',
      headers: { cookie: seller, 'content-type': 'application/json' },
      payload: { slot_id: slotId, listing_sats: 100_000 },
    });
    expect(listed.statusCode).toBe(200);

    // Buyer needs an LN balance row + sats. We seed 200_000 sats = 200_000_000 msat.
    await ctx.pool.query(
      `INSERT INTO ln_user_balances (user_email, ln_address_handle, balance_msat)
       VALUES ($1, $2, $3) ON CONFLICT (user_email) DO UPDATE SET balance_msat = EXCLUDED.balance_msat`,
      ['buyer@x.com', 'buyertestha', 200_000_000],
    );

    const taken = await ctx.app.inject({
      method: 'POST', url: '/billboard/takeover',
      headers: { cookie: buyer, 'content-type': 'application/json' },
      payload: { slot_id: slotId },
    });
    expect(taken.statusCode).toBe(200);
    const tBody = taken.json();
    expect(tBody.sats_paid).toBe(100_000);
    expect(tBody.sats_rake).toBe(1_000); // 1% of 100k
    expect(tBody.seller_credit_sats).toBe(99_000);

    // Seller should now have 99_000_000 msat credited.
    const sellerBal = await ctx.pool.query<{ balance_msat: string }>(
      `SELECT balance_msat::text FROM ln_user_balances WHERE user_email='seller@x.com'`,
    );
    expect(Number(sellerBal.rows[0]!.balance_msat)).toBe(99_000_000);

    // Buyer balance: 200_000_000 - 100_000_000 = 100_000_000.
    const buyerBal = await ctx.pool.query<{ balance_msat: string }>(
      `SELECT balance_msat::text FROM ln_user_balances WHERE user_email='buyer@x.com'`,
    );
    expect(Number(buyerBal.rows[0]!.balance_msat)).toBe(100_000_000);

    // Rake: 1_000_000 msat (1k sats) recorded.
    const rake = await ctx.pool.query<{ n: string }>(
      `SELECT coalesce(sum(amount_msat),0)::text AS n FROM protocol_rake_ledger`,
    );
    expect(Number(rake.rows[0]!.n)).toBe(1_000_000);
  });

  it('abandons a slot with required confirmation phrase', async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    await expandSupply(ctx, 1000);
    const cookie = await loginAs(ctx, 'a@x.com');
    await seedTokens(ctx, 'a@x.com', 4);
    const claimed = await ctx.app.inject({
      method: 'POST', url: '/billboard/claim',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        cell_x: 0, cell_y: 0, cell_w: 1, cell_h: 1,
        image_b64: TINY_PNG_B64, image_content_type: 'image/png',
        click_url: 'https://example.com/',
      },
    });
    const slotId = claimed.json().slot_id;

    const wrongConfirm = await ctx.app.inject({
      method: 'POST', url: '/billboard/abandon',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { slot_id: slotId, confirm: 'yes' },
    });
    expect(wrongConfirm.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: 'POST', url: '/billboard/abandon',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { slot_id: slotId, confirm: 'I UNDERSTAND THE RPOW BURN IS PERMANENT' },
    });
    expect(ok.statusCode).toBe(200);

    // Slot is gone from the visible grid but still in DB with state EMPTY.
    const grid = (await ctx.app.inject({ method: 'GET', url: '/billboard/grid' })).json();
    expect(grid).toHaveLength(0);
  });
});
