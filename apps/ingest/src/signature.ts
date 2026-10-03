import { createHmac, timingSafeEqual } from 'node:crypto';

// GitHub sends lowercase hex. Accepting either case costs nothing: the digest is compared as bytes.
const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/i;

/**
 * The 32-byte digest from an `X-Hub-Signature-256` value, or null when the header is missing or
 * malformed. A duplicated header arrives comma-joined and fails here, as does a `sha1=` value.
 */
export function parseSignatureHeader(value: string | undefined): Buffer | null {
  const hex = value === undefined ? undefined : SIGNATURE_HEADER.exec(value)?.[1];
  return hex === undefined ? null : Buffer.from(hex, 'hex');
}

/** Checks GitHub's HMAC-SHA256 over the exact bytes it sent, before anything parses them. */
export function verifySignature(secret: string, rawBody: Uint8Array, header: string | undefined): boolean {
  const provided = parseSignatureHeader(header);
  if (provided === null) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  // Both are 32 bytes here, so timingSafeEqual cannot throw on a length mismatch.
  return timingSafeEqual(expected, provided);
}
