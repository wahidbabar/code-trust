// One call from a local clone to everything the database stores for it: the walk, attribution per
// commit, and a survival rollup per measured cohort. Identities and messages are read here and
// dropped; nothing in the result carries a person's name or email.
import {
  type Attribution,
  type Cohort,
  type Commit,
  GithubIdSchema,
  type IsoTimestamp,
  IsoTimestampSchema,
  MeasuredCohortSchema,
  type SurvivalCurvePoint,
  type SurvivalMetric,
  type SurvivalObservation,
} from '@code-trust/shared';
import { attributeCommit } from './attribution/attribute.ts';
import type { HistoryCommit } from './history/types.ts';
import { walkHistory } from './history/walk.ts';
import { estimateSurvival } from './survival/estimate.ts';

export interface AnalyzeOptions {
  repoDir: string;
  /** GitHub's repository id. */
  repoId: number;
  /** A commit SHA or ref. Defaults to HEAD. */
  head?: string;
  /** When the caller fetched the head: the censoring time for lines still alive. */
  observedAt: IsoTimestamp;
}

export interface RepoAnalysis {
  /** What `setRepoHead` takes. */
  head: { headSha: string; headCommittedAt: IsoTimestamp; observedAt: IsoTimestamp };
  commits: Commit[];
  attributions: Attribution[];
  observations: SurvivalObservation[];
  /** One per measured cohort that has lines. The shape `upsertSurvivalRollup` takes. */
  rollups: { metric: SurvivalMetric; points: SurvivalCurvePoint[] }[];
}

export async function analyzeRepo(options: AnalyzeOptions): Promise<RepoAnalysis> {
  const repoId = GithubIdSchema.parse(options.repoId);
  const observedAt = IsoTimestampSchema.parse(options.observedAt);
  const history = await walkHistory(
    options.head === undefined ? { repoDir: options.repoDir } : { repoDir: options.repoDir, head: options.head },
  );
  const head = { headSha: history.headSha, headCommittedAt: history.headCommittedAt, observedAt };

  const bySha = new Map<string, HistoryCommit>(history.commits.map((commit) => [commit.sha, commit]));
  const cohorts = new Map<string, Cohort>();
  const commits: Commit[] = [];
  const attributions: Attribution[] = [];
  for (const commit of history.commits) {
    const attribution = attributeCommit(commit);
    cohorts.set(commit.sha, attribution.cohort);
    commits.push({
      repoId,
      sha: commit.sha,
      authoredAt: commit.authoredAt,
      committedAt: commit.committedAt,
      landedAt: commit.landedAt,
      cohort: attribution.cohort,
    });
    for (const found of attribution.attributions) attributions.push({ repoId, commitSha: commit.sha, ...found });
  }

  // The clock starts when a line lands on the mainline, and stops at the removing mainline commit.
  const observations: SurvivalObservation[] = history.groups.map((group) => ({
    repoId,
    introducedBy: group.introducedBy,
    removedBy: group.removedBy,
    lineCount: group.lineCount,
    introducedAt: commitFor(bySha, group.introducedBy).landedAt,
    removedAt: group.removedBy === null ? null : commitFor(bySha, group.removedBy).committedAt,
  }));

  // Automation lines keep their observations but get no curve.
  const rollups: RepoAnalysis['rollups'] = [];
  for (const cohort of MeasuredCohortSchema.options) {
    const estimate = estimateSurvival(
      observations.filter((observation) => cohorts.get(observation.introducedBy) === cohort),
      observedAt,
    );
    if (estimate === null) continue;
    const { points, ...numbers } = estimate;
    rollups.push({ metric: { repoId, cohort, headSha: head.headSha, observedAt, ...numbers }, points });
  }

  return { head, commits, attributions, observations, rollups };
}

function commitFor(bySha: ReadonlyMap<string, HistoryCommit>, sha: string): HistoryCommit {
  const commit = bySha.get(sha);
  // The walker lists exactly the commits its groups name, so this is a broken invariant, not input.
  if (commit === undefined) throw new Error(`the walk names ${sha} but did not list it`);
  return commit;
}
