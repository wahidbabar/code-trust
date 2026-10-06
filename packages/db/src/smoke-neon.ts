// `pnpm --filter @code-trust/db smoke:neon`: runs the worker's write path against Neon through the
// Neon dialect, on one fixture repo that it deletes again. The human runs it with the URL from SSM
// before the worker is deployed (README.md). It prints the host and row counts, never the URL, the
// user or the password.
//
// The routine takes a Kysely<Database>, so the tests run it through the testing-neon shim.

import { fileURLToPath } from 'node:url';
import {
  attributionFixtures,
  commitFixtures,
  repoFixture,
  SHA,
  survivalCurveFixture,
  survivalMetricFixture,
  survivalObservationFixtures,
  youngSurvivalCurveFixture,
  youngSurvivalMetricFixture,
} from '@code-trust/shared/fixtures';
import type { Kysely } from 'kysely';
import type { Database } from './database.ts';
import { parseDatabaseUrl, redactSecrets } from './database-url.ts';
import { createNeonDb } from './neon.ts';
import {
  deleteAttributionsExcept,
  deleteCommitsExcept,
  deleteRepo,
  deleteSurvivalObservationsExcept,
  getRepo,
  listAttributions,
  listCommits,
  listSurvivalMetrics,
  listSurvivalObservations,
  type RepoDetails,
  setRepoHead,
  upsertAttributions,
  upsertCommits,
  upsertRepo,
  upsertSurvivalObservations,
  upsertSurvivalRollup,
} from './queries.ts';

/**
 * The repo the smoke test writes. GitHub ids are nowhere near 2^53, so no real repo has this one,
 * and the shared fixtures' id is a real public repo, so it is not reused here.
 */
export const SMOKE_REPO: RepoDetails = {
  id: Number.MAX_SAFE_INTEGER,
  owner: 'code-trust-smoke',
  name: 'neon-smoke',
  defaultBranch: 'main',
  installationId: null,
};

export class SmokeRefusedError extends Error {
  override name = 'SmokeRefusedError';
}

export interface SmokeOptions {
  /** Printed as is; pass the host only. */
  host: string;
  log(line: string): void;
}

interface Counts {
  commits: number;
  attributions: number;
  observations: number;
  rollups: number;
}

const rekey = <T extends { repoId: number }>(rows: readonly T[]): T[] =>
  rows.map((row) => ({ ...row, repoId: SMOKE_REPO.id }));

export async function runNeonSmoke(db: Kysely<Database>, { host, log }: SmokeOptions): Promise<void> {
  const id = SMOKE_REPO.id;
  log(`host ${host}`);

  // Only ever delete what this routine wrote. A row with the smoke owner and name is a run that was
  // killed before its cleanup; anything else at this id is not ours.
  const existing = await getRepo(db, id);
  if (existing !== null) {
    if (existing.owner !== SMOKE_REPO.owner || existing.name !== SMOKE_REPO.name) {
      log(`repo ${id} exists and is not the smoke fixture: refusing to run, nothing was changed`);
      throw new SmokeRefusedError(`Repo ${id} exists and is not the smoke fixture. Nothing was changed.`);
    }
    await deleteRepo(db, id);
    log(`removed a leftover smoke repo from a run that did not finish; ${format(await count(db))}`);
  }

  // The cleanup runs whatever happens, and the first failure is the one reported.
  const failures: unknown[] = [];
  try {
    await upsertRepo(db, SMOKE_REPO);
    await upsertCommits(db, rekey(commitFixtures));
    await upsertAttributions(db, rekey(attributionFixtures));
    await upsertSurvivalObservations(db, rekey(survivalObservationFixtures));
    for (const [metric, curve] of [
      [survivalMetricFixture, survivalCurveFixture],
      [youngSurvivalMetricFixture, youngSurvivalCurveFixture],
    ] as const) {
      await upsertSurvivalRollup(db, { metric: { ...metric, repoId: id }, points: curve.points });
    }
    const { headSha, headCommittedAt, observedAt } = repoFixture;
    if (headSha === null || headCommittedAt === null || observedAt === null) throw new Error('repoFixture has no head');
    if (!(await setRepoHead(db, id, { headSha, headCommittedAt, observedAt })))
      throw new Error('setRepoHead found no repo');
    await step(db, log, 'seeded', null, { commits: 5, attributions: 3, observations: 4, rollups: 2 });

    // Dropping the removing commit d and the agent commit e takes the group (a, d) and e's attribution with them.
    const commits = await deleteCommitsExcept(db, id, [SHA.aiOld, SHA.aiRecent, SHA.removerOne]);
    await step(db, log, 'deleteCommitsExcept', [commits, 2], {
      commits: 3,
      attributions: 2,
      observations: 3,
      rollups: 2,
    });

    const attributions = await deleteAttributionsExcept(db, id, [
      { commitSha: SHA.aiOld, signal: 'co_author_trailer', tool: 'claude' },
    ]);
    await step(db, log, 'deleteAttributionsExcept', [attributions, 1], {
      commits: 3,
      attributions: 1,
      observations: 3,
      rollups: 2,
    });

    // Keeps the alive group of a next to its removed group, and drops b's alive group.
    const observations = await deleteSurvivalObservationsExcept(db, id, [
      { introducedBy: SHA.aiOld, removedBy: SHA.removerOne },
      { introducedBy: SHA.aiOld, removedBy: null },
    ]);
    await step(db, log, 'deleteSurvivalObservationsExcept', [observations, 1], {
      commits: 3,
      attributions: 1,
      observations: 2,
      rollups: 2,
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    const removed = await deleteRepo(db, id);
    if (!removed || (await getRepo(db, id)) !== null) throw new Error('deleteRepo did not remove the smoke repo');
    await step(db, log, 'deleteRepo', null, { commits: 0, attributions: 0, observations: 0, rollups: 0 });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw failures[0];
}

async function count(db: Kysely<Database>): Promise<Counts> {
  const id = SMOKE_REPO.id;
  return {
    commits: (await listCommits(db, id)).length,
    attributions: (await listAttributions(db, id)).length,
    observations: (await listSurvivalObservations(db, id)).length,
    rollups: (await listSurvivalMetrics(db, id)).length,
  };
}

const format = (counts: Counts): string =>
  `commits ${counts.commits}, attributions ${counts.attributions}, observations ${counts.observations}, rollups ${counts.rollups}`;

/** Reads the counts back, logs them, and throws when they or the number deleted are not as expected. */
async function step(
  db: Kysely<Database>,
  log: (line: string) => void,
  name: string,
  deleted: [actual: number, expected: number] | null,
  expected: Counts,
): Promise<void> {
  const actual = await count(db);
  log(`${name}: ${deleted === null ? '' : `deleted ${deleted[0]}; `}${format(actual)}`);
  if (deleted !== null && deleted[0] !== deleted[1]) {
    throw new Error(`${name} deleted ${deleted[0]} rows, expected ${deleted[1]}`);
  }
  if (format(actual) !== format(expected)) throw new Error(`${name}: expected ${format(expected)}`);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  const cause = error.cause instanceof Error ? ` (cause: ${error.cause.name}: ${error.cause.message})` : '';
  return `${error.name}: ${error.message}${typeof code === 'string' ? ` [${code}]` : ''}${cause}`;
}

async function main(): Promise<void> {
  const value = process.env.DATABASE_URL;
  if (!value) {
    console.error('DATABASE_URL is not set. Pass the Neon URL from SSM as README.md shows.');
    process.exitCode = 1;
    return;
  }
  let url: URL;
  try {
    url = parseDatabaseUrl(value);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
    return;
  }
  // 30 seconds, as the worker uses: a suspended Neon compute takes a few seconds to wake.
  const db = createNeonDb(value, { queryTimeoutMs: 30_000 });
  try {
    await runNeonSmoke(db, { host: url.host, log: (line) => console.log(line) });
    console.log('smoke:neon passed');
  } catch (error) {
    // Neon's errors can name the user, so everything printed goes through the redaction.
    console.error(`smoke:neon failed: ${redactSecrets(describeError(error), url)}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
