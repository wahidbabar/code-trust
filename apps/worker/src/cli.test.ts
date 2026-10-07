// Runs the run-job script the way `pnpm run-job` does, under Node's type stripping, which also
// proves everything it imports is erasable TypeScript.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getRepo, listCommits } from '@code-trust/db';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '@code-trust/db/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildHistory, removeTempDirs, TestRepo } from './testing.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

function runJob(args: string[], env: Record<string, string> = {}) {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('usage errors exit 2 without touching a database', () => {
  expect(runJob([]).status).toBe(2);
  expect(runJob(['https://github.com/octo-org/hello']).status).toBe(2);
  expect(runJob(['https://github.com/octo-org/hello', 'not-a-number']).status).toBe(2);
  expect(runJob(['https://github.com/octo-org/hello', '1', '--installation-id', '0']).status).toBe(2);
});

describe.skipIf(testDatabaseUrl === null)('against the database', { timeout: 60_000 }, () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.destroy();
    removeTempDirs();
  });

  test('analyzes a repo into the database and prints the head, the commit count and the statement count', async () => {
    const origin = TestRepo.create();
    buildHistory(origin, 5);
    // The scratch schema reaches the script through the URL, as the search path.
    const url = new URL(testDatabaseUrl as string);
    url.searchParams.set('options', `-c search_path=${database.schema}`);

    const run = runJob([origin.url, '4242'], { DATABASE_URL: url.href });

    expect(run.stderr).toContain('"outcome":"analyzed"');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`head ${origin.head()} (main)\ncommits 5\nstatements 10\n`);
    expect(await getRepo(database.db, 4242)).toMatchObject({ name: 'origin', headSha: origin.head() });
    expect(await listCommits(database.db, 4242)).toHaveLength(5);
  });
});
