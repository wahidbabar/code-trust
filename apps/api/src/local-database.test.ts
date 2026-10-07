import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import { describeDatabase } from './local-database.ts';

// Everything an error could show: Node's ERR_INVALID_URL keeps the whole input on `input`, which
// String(error) leaves out and inspect shows.
function everythingIn(value: unknown): string {
  return `${String(value)}\n${inspect(value, { showHidden: true, depth: 5 })}\n${JSON.stringify(value) ?? ''}`;
}

describe('describeDatabase', () => {
  test('names the database and host, never the password', () => {
    expect(describeDatabase('postgres://u:s3cret-pw@127.0.0.1:5432/ct_dev')).toBe('ct_dev on 127.0.0.1:5432');
  });

  test('describeDatabase on a malformed URL holding s3cret-pw returns or throws nothing containing it', () => {
    // A non-numeric port: new URL() rejects it and keeps the input.
    const malformed = 'postgres://u:s3cret-pw@db.example.invalid:port/ct_dev';
    expect(() => new URL(malformed)).toThrow();

    let outcome: unknown;
    try {
      outcome = describeDatabase(malformed);
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(Error);
    expect(everythingIn(outcome)).not.toContain('s3cret-pw');
    expect(String(outcome)).toContain('DATABASE_URL is not a valid URL');
  });
});
