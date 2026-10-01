import { describe, expect, test } from 'vitest';
import { resolveDatabaseUrl, testDatabaseUrl } from './testing.ts';

const FROM_ENV = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const FROM_FILE = 'postgres://postgres:postgres@127.0.0.1:54329/ct_workspace';
const WORKSPACE_ENV = `DATABASE_URL=${FROM_FILE}\n`;

describe('resolveDatabaseUrl', () => {
  test('uses DATABASE_URL when set', () => {
    expect(resolveDatabaseUrl({ env: { DATABASE_URL: FROM_ENV }, workspaceEnv: null })).toBe(FROM_ENV);
  });

  test('DATABASE_URL wins over .env.workspace', () => {
    expect(resolveDatabaseUrl({ env: { DATABASE_URL: FROM_ENV }, workspaceEnv: WORKSPACE_ENV })).toBe(FROM_ENV);
  });

  test('falls back to the workspace database', () => {
    expect(resolveDatabaseUrl({ env: {}, workspaceEnv: WORKSPACE_ENV })).toBe(FROM_FILE);
  });

  test('a blank DATABASE_URL counts as unset', () => {
    expect(resolveDatabaseUrl({ env: { DATABASE_URL: '  ' }, workspaceEnv: WORKSPACE_ENV })).toBe(FROM_FILE);
  });

  test('with no database on a laptop, the database tests skip', () => {
    expect(resolveDatabaseUrl({ env: {}, workspaceEnv: null })).toBeNull();
    expect(resolveDatabaseUrl({ env: {}, workspaceEnv: 'OTHER=1\n' })).toBeNull();
  });

  test('with no database in CI, the suite fails instead of skipping', () => {
    expect(() => resolveDatabaseUrl({ env: { CI: 'true' }, workspaceEnv: null })).toThrow(/must not skip/);
  });
});

// A skipped database suite prints as skipped, which is easy to miss. This one line says which it was.
test('reports whether the database tests have a database', () => {
  console.info(
    testDatabaseUrl === null
      ? 'db tests: NO DATABASE, database suites are skipped'
      : `db tests: running against ${new URL(testDatabaseUrl).host}${new URL(testDatabaseUrl).pathname}`,
  );
  if (process.env.CI) expect(testDatabaseUrl).not.toBeNull();
});
