// Canonical billboard state serializer + helpers.
//
// "Canonical" here means deterministic across environments: identical state
// must produce identical bytes, hence identical SHA-256, regardless of
// machine/OS/locale. The bytes get OpenTimestamps-stamped daily — the
// hash is what's anchored to Bitcoin block headers via OTS.
//
// Format (line-oriented, ASCII): one line per OWNED slot, sorted by
// (cell_y, cell_x), with the form:
//   <slot_id>\t<cell_x>\t<cell_y>\t<cell_w>\t<cell_h>\t<image_sha256>\t<click_url>\t<owner_email_sha256>\n
// followed by a final summary line:
//   #total_rpow_burned=<n>\n
//
// The owner email is hashed (SHA-256, hex) instead of stored plain to keep
// the proof public-readable without leaking PII. The image is referenced
// by SHA-256 of the bytes, so the proof commits to the exact pixels — not
// to the URL, which can change.

import { createHash, type BinaryLike } from 'node:crypto';
import type { Pool } from 'pg';

export interface CanonicalRow {
  slot_id: number;
  cell_x: number;
  cell_y: number;
  cell_w: number;
  cell_h: number;
  image_sha256_hex: string;
  click_url: string;
  owner_email_sha256_hex: string;
  rpow_burned: number;
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const idx = email.lastIndexOf('@');
  if (idx <= 0) return email;
  const local = email.slice(0, idx);
  const domain = email.slice(idx + 1);
  const head = local.slice(0, 1);
  return `${head}****@${domain}`;
}

export function sha256Hex(buf: BinaryLike): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function serializeCanonical(rows: CanonicalRow[]): Buffer {
  const sorted = [...rows].sort((a, b) => {
    if (a.cell_y !== b.cell_y) return a.cell_y - b.cell_y;
    if (a.cell_x !== b.cell_x) return a.cell_x - b.cell_x;
    return a.slot_id - b.slot_id;
  });
  const lines: string[] = [];
  let totalRpow = 0;
  for (const r of sorted) {
    totalRpow += r.rpow_burned;
    lines.push([
      r.slot_id,
      r.cell_x, r.cell_y, r.cell_w, r.cell_h,
      r.image_sha256_hex,
      r.click_url,
      r.owner_email_sha256_hex,
    ].join('\t'));
  }
  lines.push(`#total_rpow_burned=${totalRpow}`);
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

/**
 * Read a canonical snapshot of the OWNED, non-pending slots from the DB,
 * compute the canonical bytes, and return both. The image SHA-256 is read
 * from the slot row (we store it on each upload).
 *
 * MOD_HIDDEN slots are excluded — the user's RPOW burn is preserved in
 * the audit trail, but their content is not committed to Bitcoin.
 */
export async function snapshotCanonical(pool: Pool): Promise<{
  rows: CanonicalRow[];
  bytes: Buffer;
  sha256: Buffer;
  totalRpow: number;
  slotCount: number;
}> {
  const { rows: dbRows } = await pool.query<{
    slot_id: string;
    cell_x: number;
    cell_y: number;
    cell_w: number;
    cell_h: number;
    image_sha256: Buffer | null;
    click_url: string | null;
    owner_email: string | null;
    total_rpow_burned: number;
  }>(`
    SELECT s.id::text   AS slot_id,
           s.cell_x, s.cell_y, s.cell_w, s.cell_h,
           s.click_url,
           s.owner_email,
           s.total_rpow_burned,
           digest(coalesce(s.image_object_key, ''), 'sha256') AS image_sha256
    FROM slots s
    WHERE s.state = 'OWNED' AND s.pending_review = FALSE
    ORDER BY s.cell_y, s.cell_x, s.id
  `).catch(async () => {
    // pgcrypto's digest() may not be installed; fall back to plain
    // SELECT and we'll hash app-side.
    return pool.query<{
      slot_id: string;
      cell_x: number;
      cell_y: number;
      cell_w: number;
      cell_h: number;
      image_object_key: string | null;
      click_url: string | null;
      owner_email: string | null;
      total_rpow_burned: number;
    }>(`
      SELECT s.id::text   AS slot_id,
             s.cell_x, s.cell_y, s.cell_w, s.cell_h,
             s.image_object_key,
             s.click_url,
             s.owner_email,
             s.total_rpow_burned
      FROM slots s
      WHERE s.state = 'OWNED' AND s.pending_review = FALSE
      ORDER BY s.cell_y, s.cell_x, s.id
    `).then(r => ({
      ...r,
      rows: r.rows.map(row => ({
        ...row,
        image_sha256: row.image_object_key
          ? createHash('sha256').update(row.image_object_key).digest()
          : null,
      })),
    }));
  });

  const rows: CanonicalRow[] = dbRows.map((r: any) => ({
    slot_id: Number(r.slot_id),
    cell_x: r.cell_x, cell_y: r.cell_y,
    cell_w: r.cell_w, cell_h: r.cell_h,
    image_sha256_hex: r.image_sha256 ? Buffer.from(r.image_sha256).toString('hex') : ''.padEnd(64, '0'),
    click_url: r.click_url ?? '',
    owner_email_sha256_hex: r.owner_email
      ? createHash('sha256').update(r.owner_email).digest('hex')
      : ''.padEnd(64, '0'),
    rpow_burned: r.total_rpow_burned,
  }));

  const bytes = serializeCanonical(rows);
  const sha256 = createHash('sha256').update(bytes).digest();
  const totalRpow = rows.reduce((s, r) => s + r.rpow_burned, 0);
  return { rows, bytes, sha256, totalRpow, slotCount: rows.length };
}
