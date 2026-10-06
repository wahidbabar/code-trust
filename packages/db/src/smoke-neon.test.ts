import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitFixtures } from '@code-trust/shared/fixtures';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deleteRepo, listCommits, listRepos, upsertCommits, upsertRepo } from './queries.ts';
import { runNeonSmoke, SMOKE_REPO, SmokeRefusedError } from './smoke-neon.ts';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from './testing.ts';
import { installNeonShim, type NeonShim, type NeonShimHandle } from './testing-neon.ts';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

const EXPECTED_RUN = [
  'seeded: commits 5, attributions 3, observations 4, rollups 2',
  'deleteCommitsExcept: deleted 2; commits 3, attributions 2, observations 3, rollups 2',
  'deleteAttributionsExcept: deleted 1; commits 3, attributions 1, observations 3, rollups 2',
  'deleteSurvivalObservationsExcept: deleted 1; commits 3, attributions 1, observations 2, rollups 2',
  'deleteRepo: commits 0, attributions 0, observations 0, rollups 0',
];

describe.skipIf(testDatabaseUrl === null)('the smoke:neon routine through the Neon dialect', () => {
  let scratch: TestDatabase;
  let shim: NeonShim;
  let neon: NeonShimHandle;

  beforeAll(async () => {
    scratch = await createTestDatabase();
    shim = installNeonShim();
    neon = shim.connect({ schema: scratch.schema, user: 'smoke-user', password: 'smoke-pw' });
  });

  afterAll(async () => {
    await shim?.close();
    await scratch?.destroy();
  });

  beforeEach(async () => {
    for (const repo of await listRepos(scratch.db)) await deleteRepo(scratch.db, repo.id);
  });

  const run = async () => {
    const lines: string[] = [];
    const outcome = await runNeonSmoke(neon.db, { host: neon.host, log: (line) => lines.push(line) }).then(
      () => null,
      (error: unknown) => error,
    );
    return { lines, outcome };
  };

  const expectNothingSecret = (lines: string[]) => {
    const output = lines.join('\n');
    for (const secret of ['smoke-user', 'smoke-pw', 'postgres://', neon.url]) expect(output).not.toContain(secret);
  };

  test('prints the expected counts and the host, and no URL, user or password; the repo is gone afterwards', async () => {
    const { lines, outcome } = await run();
    expect(outcome).toBeNull();
    expect(lines).toEqual([`host ${neon.host}`, ...EXPECTED_RUN]);
    expectNothingSecret(lines);
    expect(await listRepos(scratch.db)).toEqual([]);
  });

  test('removes a leftover smoke repo from a run that was killed, then runs', async () => {
    await upsertRepo(scratch.db, SMOKE_REPO);
    await upsertCommits(
      scratch.db,
      commitFixtures.map((commit) => ({ ...commit, repoId: SMOKE_REPO.id })),
    );
    const { lines, outcome } = await run();
    expect(outcome).toBeNull();
    expect(lines).toEqual([
      `host ${neon.host}`,
      'removed a leftover smoke repo from a run that did not finish; commits 0, attributions 0, observations 0, rollups 0',
      ...EXPECTED_RUN,
    ]);
    expectNothingSecret(lines);
    expect(await listRepos(scratch.db)).toEqual([]);
  });

  test('refuses to run, deleting nothing, when another repo holds the smoke id', async () => {
    const stranger = { ...SMOKE_REPO, owner: 'someone-else' };
    await upsertRepo(scratch.db, stranger);
    await upsertCommits(
      scratch.db,
      commitFixtures.map((commit) => ({ ...commit, repoId: SMOKE_REPO.id })),
    );
    const before = { repos: await listRepos(scratch.db), commits: await listCommits(scratch.db, SMOKE_REPO.id) };

    const { lines, outcome } = await run();
    expect(outcome).toBeInstanceOf(SmokeRefusedError);
    expect(lines).toEqual([
      `host ${neon.host}`,
      `repo ${SMOKE_REPO.id} exists and is not the smoke fixture: refusing to run, nothing was changed`,
    ]);
    expect({ repos: await listRepos(scratch.db), commits: await listCommits(scratch.db, SMOKE_REPO.id) }).toEqual(
      before,
    );
    expect(before.commits).toHaveLength(commitFixtures.length);
  });
});

describe('the smoke:neon command', () => {
  const smoke = (env: Record<string, string>) => {
    const { DATABASE_URL: _ignored, ...rest } = process.env;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/smoke-neon.ts'], {
      cwd: PACKAGE_DIR,
      env: { ...rest, ...env },
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  };

  test('with a malformed DATABASE_URL it exits 1 without printing it', () => {
    const { status, output } = smoke({ DATABASE_URL: 'postgres://u:s3cret-pw@[bad' });
    expect(output).not.toContain('s3cret-pw');
    expect(output).toMatch(/DATABASE_URL is not a valid URL/);
    expect(status).toBe(1);
  });

  test('without DATABASE_URL it exits 1', () => {
    const { status, output } = smoke({});
    expect(output).toMatch(/DATABASE_URL is not set/);
    expect(status).toBe(1);
  });
});
