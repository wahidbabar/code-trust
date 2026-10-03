import { describe, expect, test } from 'vitest';
import { parseSignatureHeader, verifySignature } from './signature.ts';

// The example from GitHub's "Validating webhook deliveries" page.
const SECRET = "It's a Secret to Everybody";
const BODY = Buffer.from('Hello, World!');
const HEADER = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

describe("GitHub's documented test vector", () => {
  test('verifies', () => {
    expect(verifySignature(SECRET, BODY, HEADER)).toBe(true);
  });

  test('a changed body fails', () => {
    expect(verifySignature(SECRET, Buffer.from('Hello, World?'), HEADER)).toBe(false);
  });

  test('a wrong secret fails', () => {
    expect(verifySignature("It's a Secret to Nobody", BODY, HEADER)).toBe(false);
  });

  test('a sha1= header fails', () => {
    expect(verifySignature(SECRET, BODY, 'sha1=01dc10d0c83e72ed246219cdd91669667fe2ca59')).toBe(false);
    expect(verifySignature(SECRET, BODY, HEADER.replace('sha256=', 'sha1='))).toBe(false);
  });

  test('uppercase hex is the same digest', () => {
    expect(verifySignature(SECRET, BODY, `sha256=${HEADER.slice('sha256='.length).toUpperCase()}`)).toBe(true);
  });
});

describe('parseSignatureHeader', () => {
  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['prefix only', 'sha256='],
    ['63 hex digits', HEADER.slice(0, -1)],
    ['65 hex digits', `${HEADER}0`],
    ['surrounding space', ` ${HEADER}`],
    ['two values joined by a comma', `${HEADER},${HEADER}`],
  ])('rejects %s without throwing', (_, header) => {
    expect(parseSignatureHeader(header)).toBeNull();
    expect(verifySignature(SECRET, BODY, header)).toBe(false);
  });

  test('returns the 32-byte digest', () => {
    expect(parseSignatureHeader(HEADER)?.toString('hex')).toBe(HEADER.slice('sha256='.length));
  });
});
