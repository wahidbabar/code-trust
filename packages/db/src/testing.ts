// Test support for this package and for the lanes that query the database: a migrated scratch
// schema inside whichever Postgres the workspace or CI provides.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import {
  attributionFixtures,
  commitFixtures,
  repoFixture,
  survivalCurveFixture,
  survivalMetricFixture,
  survivalObservationFixtures,
  youngSurvivalCurveFixture,
  youngSurvivalMetricFixture,
} from '@code-trust/shared/fixtures';
import { type Kysely, sql } from 'kysely';
import type { Database } from './database.ts';
import { migrateToLatest } from './migrator.ts';
import { createPgDb } from './pg.ts';
import {
  type RepoHead,
  setRepoHead,
  upsertAttributions,
  upsertCommits,
  upsertRepo,
  upsertSurvivalObservations,
  upsertSurvivalRollup,
} from './queries.ts';

const WORKSPACE_ENV_FILE = new URL('../../../.env.workspace', import.meta.url);

export interface DatabaseUrlSources {
  env: Readonly<Record<string, string | undefined>>;
  /** Contents of the workspace's .env.workspace, or null when there is none. */
  workspaceEnv: string | null;
}

/**
 * Where the tests find Postgres: DATABASE_URL, else the workspace database from .env.workspace.
 * Null means there is no database and database tests should skip, which is fine on a laptop with
 * Docker stopped. In CI that would turn the suite green without running it, so there it throws.
 */
export function resolveDatabaseUrl(sources: DatabaseUrlSources): string | null {
  const fromEnv = sources.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = sources.workspaceEnv === null ? undefined : parseEnv(sources.workspaceEnv).DATABASE_URL?.trim();
  if (fromFile) return fromFile;
  if (sources.env.CI) {
    throw new Error('DATABASE_URL is not set in CI. The database tests need the Postgres service; they must not skip.');
  }
  return null;
}

function readWorkspaceEnv(): string | null {
  try {
    return readFileSync(WORKSPACE_ENV_FILE, 'utf8');
  } catch {
    return null;
  }
}

/** The database the tests in this process use, or null when they should skip. */
export const testDatabaseUrl = resolveDatabaseUrl({ env: process.env, workspaceEnv: readWorkspaceEnv() });

export interface TestDatabase {
  db: Kysely<Database>;
  schema: string;
  /** Drops the scratch schema and closes the connections. */
  destroy(): Promise<void>;
}

/** A fresh schema with every migration applied, so test files can't see each other's rows. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (testDatabaseUrl === null) throw new Error('No test database. Guard the suite with testDatabaseUrl.');
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const db = createPgDb(testDatabaseUrl, { schema });
  await migrateToLatest(db, { schema });
  return {
    db,
    schema,
    destroy: async () => {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    },
  };
}

/** The head of the analyzed repo fixture, in the shape setRepoHead takes. */
export const repoHeadFixture: RepoHead = (() => {
  const { headSha, headCommittedAt, observedAt } = repoFixture;
  if (headSha === null || headCommittedAt === null || observedAt === null) {
    throw new Error('repoFixture must be an analyzed repo.');
  }
  return { headSha, headCommittedAt, observedAt };
})();

/** Writes the shared fixtures, one analyzed repo with rows in every table, in the order a worker writes them. */
export async function seedFixtures(db: Kysely<Database>): Promise<void> {
  await upsertRepo(db, repoFixture);
  await upsertCommits(db, commitFixtures);
  await upsertAttributions(db, attributionFixtures);
  await upsertSurvivalObservations(db, survivalObservationFixtures);
  await upsertSurvivalRollup(db, { metric: survivalMetricFixture, points: survivalCurveFixture.points });
  await upsertSurvivalRollup(db, { metric: youngSurvivalMetricFixture, points: youngSurvivalCurveFixture.points });
  await setRepoHead(db, repoFixture.id, repoHeadFixture);
}
