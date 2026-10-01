// The SQL migrations and database.ts are written by hand, and so are the zod schemas. These tests
// run against real Postgres and fail when the three stop agreeing.
import { AttributionSignalSchema, CohortSchema, MeasuredCohortSchema } from '@code-trust/shared';
import { attributionFixtures, REPO_ID, repoFixture, SHA } from '@code-trust/shared/fixtures';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, test } from 'vitest';
import type { Database } from './database.ts';
import { deleteRepo, listAttributions, upsertAttributions } from './queries.ts';
import { createTestDatabase, seedFixtures, type TestDatabase, testDatabaseUrl } from './testing.ts';

const COLUMNS = {
  repos: ['id', 'owner', 'name', 'default_branch', 'installation_id', 'head_sha', 'head_committed_at', 'observed_at'],
  commits: ['repo_id', 'sha', 'authored_at', 'committed_at', 'landed_at', 'cohort'],
  attributions: ['repo_id', 'commit_sha', 'signal', 'tool', 'confidence', 'evidence'],
  survival_observations: ['repo_id', 'introduced_by', 'removed_by', 'line_count', 'introduced_at', 'removed_at'],
  survival_rollups: [
    'repo_id',
    'cohort',
    'head_sha',
    'observed_at',
    'lines_total',
    'lines_removed',
    'lines_censored',
    'survival_30d',
    'survival_90d',
    'survival_180d',
    'curve',
  ],
} as const satisfies { [Table in keyof Database]: readonly (keyof Database[Table])[] };

test('COLUMNS lists every column database.ts declares (checked by tsc)', () => {
  type Listed = { [Table in keyof Database]: (typeof COLUMNS)[Table][number] };
  type Declared = { [Table in keyof Database]: keyof Database[Table] };
  expectTypeOf<Listed>().toEqualTypeOf<Declared>();
});

describe.skipIf(testDatabaseUrl === null)('schema', () => {
  let scratch: TestDatabase;
  const TABLES = Object.keys(COLUMNS) as (keyof Database)[];

  beforeAll(async () => {
    scratch = await createTestDatabase();
  });

  afterAll(async () => {
    await scratch?.destroy();
  });

  beforeEach(async () => {
    await deleteRepo(scratch.db, REPO_ID);
    await seedFixtures(scratch.db);
  });

  const count = async (table: keyof Database): Promise<number> => {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(scratch.db);
    return rows[0]?.n ?? -1;
  };

  const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t)])));

  describe('database.ts matches the live catalog', () => {
    test('same tables, same columns', async () => {
      const { rows } = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name
        from information_schema.columns
        where table_schema = ${scratch.schema} and table_name not like 'kysely_%'
        order by table_name, ordinal_position
      `.execute(scratch.db);
      const live: Record<string, string[]> = {};
      for (const row of rows) {
        live[row.table_name] ??= [];
        live[row.table_name]?.push(row.column_name);
      }
      expect(live).toEqual(COLUMNS);
    });

    test('no table has a column for a person: no author, email or login', async () => {
      const all = Object.entries(COLUMNS).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`));
      expect(all.filter((column) => /author_(name|email)|email|login|committer/.test(column))).toEqual([]);
      // The only "name" and "owner" are the repository's.
      expect(all.filter((column) => /(^|[._])(name|owner)$/.test(column))).toEqual(['repos.owner', 'repos.name']);
    });
  });

  describe('CHECK constraints accept exactly what the zod enums accept', () => {
    const insertCommit = (sha: string, cohort: string) =>
      sql`
        insert into commits (repo_id, sha, authored_at, committed_at, landed_at, cohort)
        values (${REPO_ID}, ${sha}, now(), now(), now(), ${cohort})
      `.execute(scratch.db);

    test('commits.cohort', async () => {
      for (const [i, cohort] of CohortSchema.options.entries()) {
        await insertCommit(String(i + 1).repeat(40), cohort);
      }
      await expect(insertCommit('9'.repeat(40), 'robot')).rejects.toThrow(/commits_cohort_check/);
    });

    test('attributions.signal', async () => {
      for (const signal of AttributionSignalSchema.options) {
        await sql`
          insert into attributions (repo_id, commit_sha, signal, tool, confidence, evidence)
          values (${REPO_ID}, ${SHA.removerOne}, ${signal}, 'claude', 1, 'Claude <noreply@anthropic.com>')
        `.execute(scratch.db);
      }
      await expect(
        sql`
          insert into attributions (repo_id, commit_sha, signal, tool, confidence, evidence)
          values (${REPO_ID}, ${SHA.removerOne}, 'pr_label', 'claude', 1, 'Claude <noreply@anthropic.com>')
        `.execute(scratch.db),
      ).rejects.toThrow(/attributions_signal_check/);
    });

    test('survival_rollups.cohort', async () => {
      const stored = await sql<{ cohort: string }>`select cohort from survival_rollups order by cohort`.execute(
        scratch.db,
      );
      expect(stored.rows.map((row) => row.cohort)).toEqual([...MeasuredCohortSchema.options].sort());
      await expect(
        sql`update survival_rollups set cohort = 'automation' where cohort = 'human'`.execute(scratch.db),
      ).rejects.toThrow(/survival_rollups_cohort_check/);
    });
  });

  describe('the rules zod enforces hold in the database too', () => {
    test('a repo head is all set or all null', async () => {
      await expect(sql`update repos set head_committed_at = null`.execute(scratch.db)).rejects.toThrow(
        /repos_head_all_or_nothing/,
      );
      await sql`update repos set head_sha = null, head_committed_at = null, observed_at = null`.execute(scratch.db);
    });

    test('removed_by and removed_at are set together', async () => {
      await expect(
        sql`update survival_observations set removed_at = null where removed_by is not null`.execute(scratch.db),
      ).rejects.toThrow(/survival_observations_removed_together/);
    });

    test('a commit has one alive group, not several', async () => {
      await expect(
        sql`
          insert into survival_observations (repo_id, introduced_by, removed_by, line_count, introduced_at, removed_at)
          values (${REPO_ID}, ${SHA.aiOld}, null, 9, now(), null)
        `.execute(scratch.db),
      ).rejects.toThrow(/survival_observations_birth_and_fate/);
    });

    test('rollup line counts add up', async () => {
      await expect(sql`update survival_rollups set lines_removed = 99`.execute(scratch.db)).rejects.toThrow(
        /survival_rollups_lines_add_up/,
      );
    });

    test('an observation needs its commits', async () => {
      await expect(
        sql`
          insert into survival_observations (repo_id, introduced_by, removed_by, line_count, introduced_at, removed_at)
          values (${REPO_ID}, ${'0'.repeat(40)}, null, 1, now(), null)
        `.execute(scratch.db),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe('attribution evidence never carries a human identity', () => {
    const AI_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';
    const HUMAN_TRAILER = 'Co-Authored-By: Jane Doe <jane@example.com>';
    const [trailer] = attributionFixtures;
    if (!trailer) throw new Error('fixtures missing');

    const insertEvidence = (evidence: string) =>
      sql`
        insert into attributions (repo_id, commit_sha, signal, tool, confidence, evidence)
        values (${REPO_ID}, ${SHA.removerTwo}, 'co_author_trailer', 'claude', 1, ${evidence})
      `.execute(scratch.db);

    test('the query module refuses a trailer block before it reaches the table', async () => {
      const before = await listAttributions(scratch.db, REPO_ID);
      await expect(
        upsertAttributions(scratch.db, [{ ...trailer, evidence: `${AI_TRAILER}\n${HUMAN_TRAILER}` }]),
      ).rejects.toThrow(/exactly one identity on one line/);
      await expect(
        upsertAttributions(scratch.db, [{ ...trailer, evidence: `${AI_TRAILER}, Jane <j@example.com>` }]),
      ).rejects.toThrow(/exactly one identity on one line/);
      expect(await listAttributions(scratch.db, REPO_ID)).toEqual(before);
    });

    test('the table itself refuses multi-line and over-long evidence', async () => {
      await expect(insertEvidence(`${AI_TRAILER}\n${HUMAN_TRAILER}`)).rejects.toThrow(/attributions_evidence_check/);
      await expect(insertEvidence(`${AI_TRAILER}\r${HUMAN_TRAILER}`)).rejects.toThrow(/attributions_evidence_check/);
      await expect(insertEvidence(`${'x'.repeat(200)} <noreply@anthropic.com>`)).rejects.toThrow(
        /attributions_evidence_check/,
      );
      await insertEvidence(AI_TRAILER);
    });

    test('what is stored is the matched AI identity, nothing else', async () => {
      const stored = await listAttributions(scratch.db, REPO_ID);
      expect(stored.map((attribution) => attribution.evidence).sort()).toEqual(
        attributionFixtures.map((attribution) => attribution.evidence).sort(),
      );
      expect(stored.find((attribution) => attribution.commitSha === trailer.commitSha)?.evidence).toBe(AI_TRAILER);
    });
  });

  describe('deleting cascades', () => {
    test('deleting a repo removes all of its data in one statement', async () => {
      const other = { ...repoFixture, id: REPO_ID + 1, name: 'other' };
      await sql`
        insert into repos (id, owner, name, default_branch) values (${other.id}, ${other.owner}, ${other.name}, 'main')
      `.execute(scratch.db);

      const before = await counts();
      for (const table of TABLES) expect(before[table], `${table} should be seeded`).toBeGreaterThan(0);

      expect(await deleteRepo(scratch.db, REPO_ID)).toBe(true);

      expect(await counts()).toEqual({
        repos: 1,
        commits: 0,
        attributions: 0,
        survival_observations: 0,
        survival_rollups: 0,
      });
      expect(await deleteRepo(scratch.db, REPO_ID)).toBe(false);
      await deleteRepo(scratch.db, other.id);
    });

    test('deleting a commit removes its attributions and the lines it introduced', async () => {
      await scratch.db.deleteFrom('commits').where('sha', '=', SHA.aiOld).execute();
      const attributions = await scratch.db.selectFrom('attributions').select('commit_sha').execute();
      const observations = await scratch.db.selectFrom('survival_observations').select('introduced_by').execute();
      expect(attributions.map((row) => row.commit_sha)).not.toContain(SHA.aiOld);
      expect(observations.map((row) => row.introduced_by)).toEqual([SHA.aiRecent]);
    });

    test('deleting a commit removes the groups it removed', async () => {
      await scratch.db.deleteFrom('commits').where('sha', '=', SHA.removerOne).execute();
      const observations = await scratch.db.selectFrom('survival_observations').select('removed_by').execute();
      expect(observations.map((row) => row.removed_by).sort()).toEqual([SHA.removerTwo, null, null].sort());
    });
  });
});
