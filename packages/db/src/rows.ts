// Row to domain mappers: snake_case to camelCase, Date to UTC ISO string, bigint string to number.
// The signatures are the contract between the tables and the shared types; survival.test.ts
// asserts them at compile time.
import {
  type Attribution,
  type Commit,
  type Repo,
  type SurvivalCurve,
  SurvivalCurvePointsSchema,
  type SurvivalMetric,
  type SurvivalObservation,
} from '@code-trust/shared';
import type { Selectable } from 'kysely';
import type {
  AttributionsTable,
  CommitsTable,
  ReposTable,
  SurvivalObservationsTable,
  SurvivalRollupsTable,
} from './database.ts';

export type RepoRow = Selectable<ReposTable>;
export type CommitRow = Selectable<CommitsTable>;
export type AttributionRow = Selectable<AttributionsTable>;
export type SurvivalObservationRow = Selectable<SurvivalObservationsTable>;
export type SurvivalRollupRow = Selectable<SurvivalRollupsTable>;

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

export function toRepo(row: RepoRow): Repo {
  return {
    id: Number(row.id),
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    headSha: row.head_sha,
    headCommittedAt: isoOrNull(row.head_committed_at),
    observedAt: isoOrNull(row.observed_at),
  };
}

export function toCommit(row: CommitRow): Commit {
  return {
    repoId: Number(row.repo_id),
    sha: row.sha,
    authoredAt: iso(row.authored_at),
    committedAt: iso(row.committed_at),
    landedAt: iso(row.landed_at),
    cohort: row.cohort,
  };
}

export function toAttribution(row: AttributionRow): Attribution {
  return {
    repoId: Number(row.repo_id),
    commitSha: row.commit_sha,
    signal: row.signal,
    tool: row.tool,
    confidence: row.confidence,
    evidence: row.evidence,
  };
}

export function toSurvivalObservation(row: SurvivalObservationRow): SurvivalObservation {
  return {
    repoId: Number(row.repo_id),
    introducedBy: row.introduced_by,
    removedBy: row.removed_by,
    lineCount: row.line_count,
    introducedAt: iso(row.introduced_at),
    removedAt: isoOrNull(row.removed_at),
  };
}

export function toSurvivalMetric(row: Omit<SurvivalRollupRow, 'curve'>): SurvivalMetric {
  return {
    repoId: Number(row.repo_id),
    cohort: row.cohort,
    headSha: row.head_sha,
    observedAt: iso(row.observed_at),
    linesTotal: row.lines_total,
    linesRemoved: row.lines_removed,
    linesCensored: row.lines_censored,
    survival30d: row.survival_30d,
    survival90d: row.survival_90d,
    survival180d: row.survival_180d,
  };
}

// jsonb has no column types to lean on, so the curve is checked with zod every time it is read.
export function toSurvivalCurve(row: Pick<SurvivalRollupRow, 'cohort' | 'curve'>): SurvivalCurve {
  return { cohort: row.cohort, points: SurvivalCurvePointsSchema.parse(row.curve) };
}
