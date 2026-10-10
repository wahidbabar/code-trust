import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadMigrations, migrateToLatest } from './migrator.ts';
import { createTestDatabase, type TestDatabase, testDatabaseUrl, withScratchSchemaLock } from './testing.ts';

test('migration files are named NNNN_snake_case, so file-name order is apply order', async () => {
  const names = Object.keys(await loadMigrations());
  expect(names[0]).toBe('0001_init');
  for (const name of names) expect(name).toMatch(/^\d{4}_[a-z0-9_]+$/);
  expect(names).toEqual([...names].sort());
});

describe.skipIf(testDatabaseUrl === null)('migrateToLatest', () => {
  let scratch: TestDatabase;

  beforeAll(async () => {
    scratch = await createTestDatabase();
  });

  afterAll(async () => {
    await scratch?.destroy();
  });

  const catalog = async () => {
    const columns = await sql<{ column: string }>`
      select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable as column
      from information_schema.columns
      where table_schema = ${scratch.schema}
      order by 1
    `.execute(scratch.db);
    const applied = await sql<{ name: string; timestamp: string }>`
      select name, timestamp from ${sql.id(scratch.schema, 'kysely_migration')} order by name
    `.execute(scratch.db);
    return { columns: columns.rows.map((row) => row.column), applied: applied.rows };
  };

  test('the first run applied every migration into the scratch schema', async () => {
    const { applied, columns } = await catalog();
    expect(applied.map((row) => row.name)).toEqual(Object.keys(await loadMigrations()));
    expect(columns).toContain('survival_observations.line_count integer NO');
  });

  test('a second run applies nothing and changes nothing', async () => {
    const before = await catalog();
    // Shared, as createTestDatabase holds it: the Migrator reads every schema, and another file may
    // be dropping its own.
    const second = await withScratchSchemaLock(scratch.db, 'shared', () =>
      migrateToLatest(scratch.db, { schema: scratch.schema }),
    );
    expect(second.applied).toEqual([]);
    expect(await catalog()).toEqual(before);
  });
});
