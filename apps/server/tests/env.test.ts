import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/env.js';

describe('parseEnv', () => {
  it('parses a valid env', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
      DIFFICULTY_BITS: '8',
    });
    expect(env.DIFFICULTY_BITS).toBe(8);
  });
  it('rejects when DATABASE_URL missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });
});
