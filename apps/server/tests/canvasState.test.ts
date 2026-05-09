import { describe, it, expect } from 'vitest';
import { serializeCanonical, sha256Hex, maskEmail } from '../src/billboard/state.js';
import { nextFireAt } from '../src/billboard/otsCron.js';

describe('billboard canonical state', () => {
  it('produces stable bytes regardless of input order', async () => {
    const rows = [
      {
        slot_id: 7, cell_x: 0, cell_y: 0, cell_w: 1, cell_h: 1,
        image_sha256_hex: 'a'.repeat(64), click_url: 'https://b.test/',
        owner_email_sha256_hex: '1'.repeat(64), rpow_burned: 100,
      },
      {
        slot_id: 1, cell_x: 5, cell_y: 5, cell_w: 1, cell_h: 1,
        image_sha256_hex: 'b'.repeat(64), click_url: 'https://a.test/',
        owner_email_sha256_hex: '2'.repeat(64), rpow_burned: 100,
      },
    ];
    const a = serializeCanonical(rows);
    const b = serializeCanonical([...rows].reverse());
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    // First line has slot_id=7 because (cell_y,cell_x) sorts (0,0) before (5,5).
    expect(a.toString('utf8').split('\n')[0]!.startsWith('7\t')).toBe(true);
  });

  it('embeds total_rpow_burned in the trailer', () => {
    const rows = [
      {
        slot_id: 1, cell_x: 0, cell_y: 0, cell_w: 1, cell_h: 1,
        image_sha256_hex: 'a'.repeat(64), click_url: '', owner_email_sha256_hex: '1'.repeat(64), rpow_burned: 400,
      },
      {
        slot_id: 2, cell_x: 1, cell_y: 0, cell_w: 1, cell_h: 1,
        image_sha256_hex: 'a'.repeat(64), click_url: '', owner_email_sha256_hex: '2'.repeat(64), rpow_burned: 100,
      },
    ];
    expect(serializeCanonical(rows).toString('utf8')).toContain('#total_rpow_burned=500');
  });
});

describe('maskEmail', () => {
  it('masks local part to first letter + ****', () => {
    expect(maskEmail('alice@gmail.com')).toBe('a****@gmail.com');
    expect(maskEmail('b@x.com')).toBe('b****@x.com');
  });
  it('passes through nullish', () => {
    expect(maskEmail(null)).toBe(null);
    expect(maskEmail(undefined)).toBe(null);
  });
});

describe('OTS cron scheduling', () => {
  it('fires at next 00:05 UTC', () => {
    const morning = new Date('2026-05-08T03:00:00Z');
    const next = nextFireAt(morning);
    expect(next.toISOString()).toBe('2026-05-09T00:05:00.000Z');
  });
  it('skips today if it is already past 00:05 UTC', () => {
    const evening = new Date('2026-05-08T23:30:00Z');
    expect(nextFireAt(evening).toISOString()).toBe('2026-05-09T00:05:00.000Z');
  });
  it('fires today if before 00:05 UTC', () => {
    const earlyMorning = new Date('2026-05-08T00:01:00Z');
    expect(nextFireAt(earlyMorning).toISOString()).toBe('2026-05-08T00:05:00.000Z');
  });
});
