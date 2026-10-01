// The tables as Kysely sees them. Hand-written next to migrations/*.sql, so the two can drift;
// schema.test.ts compares this file with the live catalog and survival.test.ts with the zod types.
import type { AttributionSignal, Cohort, MeasuredCohort } from '@code-trust/shared';
import type { ColumnType } from 'kysely';

// Postgres drivers return bigint as a string, because it may not fit a double. Our bigints are
// GitHub ids, which do, so rows.ts turns them back into numbers.
type Int8 = ColumnType<string, number, number>;

// Read as Date, written as the UTC ISO strings the shared types carry.
type Timestamptz = ColumnType<Date, string, string>;

// Written as JSON text: handed a JavaScript array, pg would build a Postgres array instead.
type Jsonb = ColumnType<unknown, string, string>;

export interface ReposTable {
  id: Int8;
  owner: string;
  name: string;
  default_branch: string;
  installation_id: Int8 | null;
  head_sha: string | null;
  head_committed_at: Timestamptz | null;
  observed_at: Timestamptz | null;
}

export interface CommitsTable {
  repo_id: Int8;
  sha: string;
  authored_at: Timestamptz;
  committed_at: Timestamptz;
  landed_at: Timestamptz;
  cohort: Cohort;
}

export interface AttributionsTable {
  repo_id: Int8;
  commit_sha: string;
  signal: AttributionSignal;
  tool: string;
  confidence: number;
  evidence: string;
}

export interface SurvivalObservationsTable {
  repo_id: Int8;
  introduced_by: string;
  removed_by: string | null;
  line_count: number;
  introduced_at: Timestamptz;
  removed_at: Timestamptz | null;
}

export interface SurvivalRollupsTable {
  repo_id: Int8;
  cohort: MeasuredCohort;
  head_sha: string;
  observed_at: Timestamptz;
  lines_total: number;
  lines_removed: number;
  lines_censored: number;
  survival_30d: number | null;
  survival_90d: number | null;
  survival_180d: number | null;
  curve: Jsonb;
}

export interface Database {
  repos: ReposTable;
  commits: CommitsTable;
  attributions: AttributionsTable;
  survival_observations: SurvivalObservationsTable;
  survival_rollups: SurvivalRollupsTable;
}
