// Minimal OpenTimestamps client.
//
// We don't depend on the full `javascript-opentimestamps` package. We
// instead speak the calendar HTTP protocol directly, which is small:
//
//   POST /digest  body=<32-byte SHA256>  → 200 OK with binary body
//        ("the calendar's commitment-path operations for this digest;
//         when prepended with a small header, this becomes a valid
//         .ots file the user can `ots upgrade` and `ots verify` later.")
//
//   GET /timestamp/<commitment-hex>      → 200 OK once the commitment
//                                          batch lands in a Bitcoin
//                                          block, returning the upgraded
//                                          path operations.
//
// File format:
//   magic bytes        : "\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94" (header)
//   version            : 0x01
//   file hash op       : 0x08 (SHA-256), 32 bytes of the digest
//   timestamp ops      : as returned by the calendar
//
// We construct the file header here and concatenate the calendar response.

import { createHash } from 'node:crypto';

// File header constants per ots.proto spec.
// https://github.com/opentimestamps/python-opentimestamps/blob/master/opentimestamps/core/timestamp.py
const HEADER_MAGIC = Buffer.from(
  '004f70656e54696d657374616d7073000050726f6f660000bf89e2e884e89294',
  'hex',
);
const FILE_VERSION = Buffer.from([0x01]);
const OP_SHA256 = Buffer.from([0x08]);

export interface OtsCalendar {
  url: string;
}

export interface OtsStampResult {
  /** The .ots file body as bytes. */
  proof: Buffer;
  /** Calendar URL the proof is attached to. */
  calendarUrl: string;
}

/**
 * Submit a SHA-256 digest to one or more OTS calendar pool servers and
 * build a .ots proof. We try calendars in order until one returns a
 * valid response — the proof needs only one calendar to be verifiable
 * later (more is just redundancy).
 *
 * Note: the response from a single calendar is a complete `.ots` body
 * minus the file header. We prepend the standard header and the SHA256
 * file-hash op. The result is what an `ots verify` invocation expects.
 */
export async function stampDigest(
  digest: Buffer,
  calendars: OtsCalendar[],
  fetchImpl: typeof fetch = fetch,
): Promise<OtsStampResult> {
  if (digest.length !== 32) throw new Error('OTS digest must be exactly 32 bytes (SHA-256)');
  if (calendars.length === 0) throw new Error('OTS: no calendars configured');

  const errors: string[] = [];
  for (const cal of calendars) {
    try {
      const url = `${cal.url.replace(/\/+$/, '')}/digest`;
      const res = await fetchImpl(url, {
        method: 'POST',
        body: digest,
        headers: { 'content-type': 'application/octet-stream', accept: 'application/octet-stream' },
      });
      if (!res.ok) {
        errors.push(`${cal.url}: HTTP ${res.status}`);
        continue;
      }
      const calendarOps = Buffer.from(await res.arrayBuffer());

      const proof = Buffer.concat([
        HEADER_MAGIC,
        FILE_VERSION,
        OP_SHA256,
        digest,
        calendarOps,
      ]);
      return { proof, calendarUrl: cal.url };
    } catch (e: any) {
      errors.push(`${cal.url}: ${e?.message ?? e}`);
    }
  }
  throw new Error(`OTS: all calendars failed: ${errors.join('; ')}`);
}

/**
 * Compute the SHA-256 of a buffer, since the OTS calendar wants the
 * already-hashed digest, not the original payload.
 */
export function sha256(b: Buffer): Buffer {
  return createHash('sha256').update(b).digest();
}
