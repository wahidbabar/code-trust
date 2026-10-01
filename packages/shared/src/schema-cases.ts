// Test helper: runs the same round-trip checks over every schema a module exports, and fails when
// a schema has no cases. That is what keeps "every schema is tested" true as schemas are added.
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

export interface InvalidCase {
  why: string;
  value: unknown;
  /** Where the error must point. */
  path: PropertyKey[];
  /** What the error must say. */
  message: RegExp;
}

export interface SchemaCases {
  valid: unknown[];
  invalid: InvalidCase[];
}

export function describeSchemas(moduleExports: Record<string, unknown>, cases: Record<string, SchemaCases>): void {
  const schemas = Object.entries(moduleExports).filter(
    (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
  );

  test('every exported schema has valid and invalid cases', () => {
    expect(schemas.length).toBeGreaterThan(0);
    for (const [name] of schemas) {
      expect(cases[name]?.valid.length ?? 0, `${name} has no valid case`).toBeGreaterThan(0);
      expect(cases[name]?.invalid.length ?? 0, `${name} has no invalid case`).toBeGreaterThan(0);
    }
    expect(Object.keys(cases).sort()).toEqual(schemas.map(([name]) => name).sort());
  });

  describe.each(schemas)('%s', (name, schema) => {
    const { valid, invalid } = cases[name] ?? { valid: [], invalid: [] };

    test.each(valid.map((value, i) => [i, value] as const))('valid case %i round-trips', (_i, value) => {
      expect(schema.parse(value)).toEqual(value);
      // Queue messages and API responses cross a JSON boundary, so the JSON form must parse back the same.
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    });

    test.each(invalid)('rejects $why', ({ value, path, message }) => {
      const result = schema.safeParse(value);
      expect(result.success).toBe(false);
      if (result.success) return;
      const report = z.prettifyError(result.error);
      const issue = result.error.issues.find((candidate) => samePath(candidate.path, path));
      expect(issue, `no issue at ${path.join('.') || '(root)'} in:\n${report}`).toBeDefined();
      expect(issue?.message).toMatch(message);
    });
  });
}

function samePath(a: PropertyKey[], b: PropertyKey[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}
