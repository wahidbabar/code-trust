// The typed query module. Every function takes the database first and speaks the shared types.
//
// Writes are built to work without an interactive transaction, which Neon's HTTP driver does not
// have: each one is a single idempotent statement, an upsert that carries absolute values or a
// keyed delete. A worker writes in this order: upsertRepo, commits, attributions, observations,
// deleteCommitsExcept, deleteAttributionsExcept, deleteSurvivalObservationsExcept, rollups, then
// setRepoHead. Only setRepoHead moves the head, so a job that dies midway leaves the old one, and
// running it again converges. Nothing here calls db.transaction().
//
// One thing does not converge: a measured cohort left with no lines gets no rollup from the
// analyzer, so its old rollup row stays. That row names an older head, and readers filter rollups
// on the repo's head, so it is never shown. Removing it is left to hardening.
//
// Every write is parsed with its zod schema first, so nothing reaches a table that the contract
// would reject, attribution evidence included.
import {
  type Attribution,
  AttributionSchema,
  AttributionSignalSchema,
  type Commit,
  CommitSchema,
  CommitShaSchema,
  IsoTimestampSchema,
  type MeasuredCohort,
  type Repo,
  RepoSchema,
  type SurvivalCurve,
  type SurvivalCurvePoint,
  SurvivalCurvePointsSchema,
  type SurvivalMetric,
  SurvivalMetricSchema,
  type SurvivalObservation,
  SurvivalObservationSchema,
} from '@code-trust/shared';
import { type Kysely, type SqlBool, sql } from 'kysely';
import type { Database } from './database.ts';
import { toAttribution, toCommit, toRepo, toSurvivalCurve, toSurvivalMetric, toSurvivalObservation } from './rows.ts';

export type Db = Kysely<Database>;

/** One cohort's rollup: the headline numbers and the curve behind them, stored as one row. */
export interface SurvivalRollup {
  metric: SurvivalMetric;
  points: SurvivalCurvePoint[];
}

/** Names one group of lines in survival_observations. */
export type SurvivalObservationKey = Pick<SurvivalObservation, 'introducedBy' | 'removedBy'>;

/** Names one attribution of a commit. */
export type AttributionKey = Pick<Attribution, 'commitSha' | 'signal' | 'tool'>;

// Postgres takes at most 65535 bind parameters per statement; the widest row here binds 6.
const BATCH_ROWS = 1000;

function batches<T>(rows: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH_ROWS) result.push(rows.slice(i, i + BATCH_ROWS));
  return result;
}

// bigint columns compare against strings, the type the driver returns them as.
const id = (value: number): string => String(value);

/** What GitHub says about a repo. The analyzed head is not part of it; see setRepoHead. */
export type RepoDetails = Pick<Repo, 'id' | 'owner' | 'name' | 'defaultBranch' | 'installationId'>;

/** The analyzed head, always set as a whole. */
export type RepoHead = { [Field in 'headSha' | 'headCommittedAt' | 'observedAt']: NonNullable<Repo[Field]> };

/**
 * Creates the repo with no head, or updates what GitHub says about it. It never touches the head
 * of an existing repo, so a rename, a reinstall or the first step of a new analysis cannot wipe
 * the head that the stored metrics belong to.
 */
export async function upsertRepo(db: Db, details: RepoDetails): Promise<void> {
  const r = RepoSchema.parse({
    id: details.id,
    owner: details.owner,
    name: details.name,
    defaultBranch: details.defaultBranch,
    installationId: details.installationId,
    headSha: null,
    headCommittedAt: null,
    observedAt: null,
  });
  await db
    .insertInto('repos')
    .values({
      id: r.id,
      owner: r.owner,
      name: r.name,
      default_branch: r.defaultBranch,
      installation_id: r.installationId,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet((eb) => ({
        owner: eb.ref('excluded.owner'),
        name: eb.ref('excluded.name'),
        default_branch: eb.ref('excluded.default_branch'),
        installation_id: eb.ref('excluded.installation_id'),
      })),
    )
    .execute();
}

/**
 * The last write of an analysis: points the repo at the head its stored metrics now describe.
 * Until this runs the repo keeps its previous head, so a job that dies midway is invisible.
 * Returns false when the repo does not exist.
 */
export async function setRepoHead(db: Db, repoId: number, head: RepoHead): Promise<boolean> {
  const result = await db
    .updateTable('repos')
    .set({
      head_sha: CommitShaSchema.parse(head.headSha),
      head_committed_at: IsoTimestampSchema.parse(head.headCommittedAt),
      observed_at: IsoTimestampSchema.parse(head.observedAt),
    })
    .where('id', '=', id(repoId))
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

export async function getRepo(db: Db, repoId: number): Promise<Repo | null> {
  const row = await db.selectFrom('repos').selectAll().where('id', '=', id(repoId)).executeTakeFirst();
  return row ? toRepo(row) : null;
}

export async function listRepos(db: Db): Promise<Repo[]> {
  const rows = await db.selectFrom('repos').selectAll().orderBy('owner').orderBy('name').orderBy('id').execute();
  return rows.map(toRepo);
}

/** Removes the repo and, through the cascading keys, everything stored about it. */
export async function deleteRepo(db: Db, repoId: number): Promise<boolean> {
  const result = await db.deleteFrom('repos').where('id', '=', id(repoId)).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

export async function upsertCommits(db: Db, commits: readonly Commit[]): Promise<void> {
  for (const batch of batches(CommitSchema.array().parse(commits))) {
    await db
      .insertInto('commits')
      .values(
        batch.map((c) => ({
          repo_id: c.repoId,
          sha: c.sha,
          authored_at: c.authoredAt,
          committed_at: c.committedAt,
          landed_at: c.landedAt,
          cohort: c.cohort,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['repo_id', 'sha']).doUpdateSet((eb) => ({
          authored_at: eb.ref('excluded.authored_at'),
          committed_at: eb.ref('excluded.committed_at'),
          landed_at: eb.ref('excluded.landed_at'),
          cohort: eb.ref('excluded.cohort'),
        })),
      )
      .execute();
  }
}

export async function listCommits(db: Db, repoId: number): Promise<Commit[]> {
  const rows = await db
    .selectFrom('commits')
    .selectAll()
    .where('repo_id', '=', id(repoId))
    .orderBy('landed_at')
    .orderBy('sha')
    .execute();
  return rows.map(toCommit);
}

export async function upsertAttributions(db: Db, attributions: readonly Attribution[]): Promise<void> {
  for (const batch of batches(AttributionSchema.array().parse(attributions))) {
    await db
      .insertInto('attributions')
      .values(
        batch.map((a) => ({
          repo_id: a.repoId,
          commit_sha: a.commitSha,
          signal: a.signal,
          tool: a.tool,
          confidence: a.confidence,
          evidence: a.evidence,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['repo_id', 'commit_sha', 'signal', 'tool']).doUpdateSet((eb) => ({
          confidence: eb.ref('excluded.confidence'),
          evidence: eb.ref('excluded.evidence'),
        })),
      )
      .execute();
  }
}

export async function listAttributions(db: Db, repoId: number): Promise<Attribution[]> {
  const rows = await db
    .selectFrom('attributions')
    .selectAll()
    .where('repo_id', '=', id(repoId))
    .orderBy('commit_sha')
    .orderBy('signal')
    .orderBy('tool')
    .execute();
  return rows.map(toAttribution);
}

/** `lineCount` is the group's current size, not a change to it, so writing the same rows twice is harmless. */
export async function upsertSurvivalObservations(db: Db, observations: readonly SurvivalObservation[]): Promise<void> {
  for (const batch of batches(SurvivalObservationSchema.array().parse(observations))) {
    await db
      .insertInto('survival_observations')
      .values(
        batch.map((o) => ({
          repo_id: o.repoId,
          introduced_by: o.introducedBy,
          removed_by: o.removedBy,
          line_count: o.lineCount,
          introduced_at: o.introducedAt,
          removed_at: o.removedAt,
        })),
      )
      .onConflict((oc) =>
        oc.constraint('survival_observations_birth_and_fate').doUpdateSet((eb) => ({
          line_count: eb.ref('excluded.line_count'),
          introduced_at: eb.ref('excluded.introduced_at'),
          removed_at: eb.ref('excluded.removed_at'),
        })),
      )
      .execute();
  }
}

/** For groups that no longer exist, such as a commit's alive group once its last line is removed. */
export async function deleteSurvivalObservations(
  db: Db,
  repoId: number,
  keys: readonly SurvivalObservationKey[],
): Promise<void> {
  for (const batch of batches(keys)) {
    await db
      .deleteFrom('survival_observations')
      .where('repo_id', '=', id(repoId))
      .where((eb) =>
        eb.or(
          batch.map((key) =>
            eb.and([
              eb('introduced_by', '=', key.introducedBy),
              eb('removed_by', 'is not distinct from', key.removedBy),
            ]),
          ),
        ),
      )
      .execute();
  }
}

// The prunes below make a repo's stored rows equal the latest analysis. Each is one statement
// whatever the size of its keep list: the list travels as array parameters and is read with unnest,
// so a long list adds no bind parameters. An empty list keeps nothing.

/**
 * Removes the repo's commits that are not in `keepShas`, and through the cascades their
 * attributions and every observation they introduced or removed. `keepShas` must therefore name
 * every commit a kept attribution or observation refers to. Returns the number of commits removed.
 */
export async function deleteCommitsExcept(db: Db, repoId: number, keepShas: readonly string[]): Promise<number> {
  const keep = CommitShaSchema.array().parse(keepShas);
  const result = await db
    .deleteFrom('commits')
    .where('repo_id', '=', id(repoId))
    .where(
      sql<SqlBool>`not exists (
        select from unnest(${keep}::text[]) as keep(sha)
        where keep.sha = commits.sha
      )`,
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** Removes the repo's attributions that are not in `keepKeys`. Returns the number removed. */
export async function deleteAttributionsExcept(
  db: Db,
  repoId: number,
  keepKeys: readonly AttributionKey[],
): Promise<number> {
  // Parsed a column at a time: the columns are what travel as arrays.
  const shas = CommitShaSchema.array().parse(keepKeys.map((key) => key.commitSha));
  const signals = AttributionSignalSchema.array().parse(keepKeys.map((key) => key.signal));
  const tools = AttributionSchema.shape.tool.array().parse(keepKeys.map((key) => key.tool));
  const result = await db
    .deleteFrom('attributions')
    .where('repo_id', '=', id(repoId))
    .where(
      sql<SqlBool>`not exists (
        select from unnest(
          ${shas}::text[],
          ${signals}::text[],
          ${tools}::text[]
        ) as keep(commit_sha, signal, tool)
        where keep.commit_sha = attributions.commit_sha
          and keep.signal = attributions.signal
          and keep.tool = attributions.tool
      )`,
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * Removes the repo's observation groups whose (introducedBy, removedBy) is not in `keepKeys`. A null
 * removedBy (an alive group) matches only a null, the same rule as the table's unique constraint.
 * Returns the number of groups removed.
 */
export async function deleteSurvivalObservationsExcept(
  db: Db,
  repoId: number,
  keepKeys: readonly SurvivalObservationKey[],
): Promise<number> {
  const introducedBy = CommitShaSchema.array().parse(keepKeys.map((key) => key.introducedBy));
  const removedBy = CommitShaSchema.nullable()
    .array()
    .parse(keepKeys.map((key) => key.removedBy));
  const result = await db
    .deleteFrom('survival_observations')
    .where('repo_id', '=', id(repoId))
    .where(
      sql<SqlBool>`not exists (
        select from unnest(
          ${introducedBy}::text[],
          ${removedBy}::text[]
        ) as keep(introduced_by, removed_by)
        where keep.introduced_by = survival_observations.introduced_by
          and keep.removed_by is not distinct from survival_observations.removed_by
      )`,
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** A repo's observations, or only those whose introducing commit is in `cohort`: the input to one survival curve. */
export async function listSurvivalObservations(
  db: Db,
  repoId: number,
  cohort?: MeasuredCohort,
): Promise<SurvivalObservation[]> {
  let query = db.selectFrom('survival_observations').selectAll().where('repo_id', '=', id(repoId));
  if (cohort !== undefined) {
    query = query.where(
      'introduced_by',
      'in',
      db.selectFrom('commits').select('sha').where('repo_id', '=', id(repoId)).where('cohort', '=', cohort),
    );
  }
  const rows = await query.orderBy('introduced_at').orderBy('introduced_by').orderBy('removed_at').execute();
  return rows.map(toSurvivalObservation);
}

export async function upsertSurvivalRollup(db: Db, rollup: SurvivalRollup): Promise<void> {
  const m = SurvivalMetricSchema.parse(rollup.metric);
  const curve = JSON.stringify(SurvivalCurvePointsSchema.parse(rollup.points));
  await db
    .insertInto('survival_rollups')
    .values({
      repo_id: m.repoId,
      cohort: m.cohort,
      head_sha: m.headSha,
      observed_at: m.observedAt,
      lines_total: m.linesTotal,
      lines_removed: m.linesRemoved,
      lines_censored: m.linesCensored,
      survival_30d: m.survival30d,
      survival_90d: m.survival90d,
      survival_180d: m.survival180d,
      curve,
    })
    .onConflict((oc) =>
      oc.columns(['repo_id', 'cohort']).doUpdateSet((eb) => ({
        head_sha: eb.ref('excluded.head_sha'),
        observed_at: eb.ref('excluded.observed_at'),
        lines_total: eb.ref('excluded.lines_total'),
        lines_removed: eb.ref('excluded.lines_removed'),
        lines_censored: eb.ref('excluded.lines_censored'),
        survival_30d: eb.ref('excluded.survival_30d'),
        survival_90d: eb.ref('excluded.survival_90d'),
        survival_180d: eb.ref('excluded.survival_180d'),
        curve: eb.ref('excluded.curve'),
      })),
    )
    .execute();
}

export async function listSurvivalMetrics(db: Db, repoId: number): Promise<SurvivalMetric[]> {
  const rows = await db
    .selectFrom('survival_rollups')
    .select([
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
    ])
    .where('repo_id', '=', id(repoId))
    .orderBy('cohort')
    .execute();
  return rows.map(toSurvivalMetric);
}

export async function getSurvivalCurves(db: Db, repoId: number): Promise<SurvivalCurve[]> {
  const rows = await db
    .selectFrom('survival_rollups')
    .select(['cohort', 'curve'])
    .where('repo_id', '=', id(repoId))
    .orderBy('cohort')
    .execute();
  return rows.map(toSurvivalCurve);
}
