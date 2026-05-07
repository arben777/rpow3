import { describe, it, expect } from 'vitest';
import { FakeMailer } from '../src/mailer.js';

describe('FakeMailer', () => {
  it('captures sent messages for inspection', async () => {
    const m = new FakeMailer();
    await m.send({ to: 'a@b.com', subject: 's', html: '<a href="x">x</a>', text: 'x' });
    expect(m.outbox).toHaveLength(1);
    expect(m.outbox[0]!.to).toBe('a@b.com');
    expect(m.lastTo('a@b.com')!.html).toContain('href="x"');
  });
});
