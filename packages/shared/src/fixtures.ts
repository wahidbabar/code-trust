// Valid examples of every contract, for this package's tests and for the lanes that build on it.
// Import from '@code-trust/shared/fixtures' so none of this reaches a production bundle.
import type { ListReposResponse, RepoSummaryResponse, SurvivalCurveResponse } from './api.ts';
import type {
  ApiRepo,
  Attribution,
  Commit,
  CommitSha,
  IsoTimestamp,
  LineSpan,
  Repo,
  SurvivalCurve,
  SurvivalMetric,
  SurvivalObservation,
} from './domain.ts';
import type { AnalysisJobMessage, DeleteRepoJobMessage, RepoEventMessage } from './queue.ts';

const DAY_MS = 86_400_000;

const sha = (hexDigit: string): CommitSha => hexDigit.repeat(40);

const daysBefore = (iso: IsoTimestamp, days: number): IsoTimestamp =>
  new Date(Date.parse(iso) - days * DAY_MS).toISOString();

const daysAfter = (iso: IsoTimestamp, days: number): IsoTimestamp => daysBefore(iso, -days);

export const REPO_ID = 1_296_269;
export const INSTALLATION_ID = 52_340_917;

export const OBSERVED_AT: IsoTimestamp = '2026-10-01T00:00:00.000Z';

export const SHA = {
  /** AI commit behind most of the worked example. */
  aiOld: sha('a'),
  /** AI commit whose lines are only 45 days old. */
  aiRecent: sha('b'),
  /** Human commits that each removed some of `aiOld`'s lines. */
  removerOne: sha('c'),
  removerTwo: sha('d'),
  /** An AI agent's commit, attributed by its author identity. */
  agent: sha('e'),
  head: sha('f'),
} as const;

const AI_OLD_LANDED = daysBefore(OBSERVED_AT, 200.5);
const AI_RECENT_LANDED = daysBefore(OBSERVED_AT, 45.25);
const REMOVER_ONE_LANDED = daysAfter(AI_OLD_LANDED, 10.5);
const REMOVER_TWO_LANDED = daysAfter(AI_OLD_LANDED, 60.5);
const HEAD_COMMITTED_AT = daysBefore(OBSERVED_AT, 2);

export const repoFixture: Repo = {
  id: REPO_ID,
  owner: 'octo-org',
  name: 'hello.world',
  defaultBranch: 'main',
  installationId: INSTALLATION_ID,
  headSha: SHA.head,
  headCommittedAt: HEAD_COMMITTED_AT,
  observedAt: OBSERVED_AT,
};

/** A repo the App was just installed on: nothing analyzed yet. */
export const newRepoFixture: Repo = {
  ...repoFixture,
  headSha: null,
  headCommittedAt: null,
  observedAt: null,
};

const commit = (commitSha: CommitSha, landedAt: IsoTimestamp, cohort: Commit['cohort']): Commit => ({
  repoId: REPO_ID,
  sha: commitSha,
  // Written an hour before it landed, as a commit on a short-lived branch would be.
  authoredAt: daysBefore(landedAt, 1 / 24),
  committedAt: landedAt,
  landedAt,
  cohort,
});

export const commitFixtures: Commit[] = [
  commit(SHA.aiOld, AI_OLD_LANDED, 'ai'),
  commit(SHA.aiRecent, AI_RECENT_LANDED, 'ai'),
  commit(SHA.removerOne, REMOVER_ONE_LANDED, 'human'),
  commit(SHA.removerTwo, REMOVER_TWO_LANDED, 'human'),
  commit(SHA.agent, daysBefore(OBSERVED_AT, 5), 'ai'),
];

export const attributionFixtures: Attribution[] = [
  {
    repoId: REPO_ID,
    commitSha: SHA.aiOld,
    signal: 'co_author_trailer',
    tool: 'claude',
    confidence: 1,
    evidence: 'Co-Authored-By: Claude <noreply@anthropic.com>',
  },
  {
    repoId: REPO_ID,
    commitSha: SHA.aiRecent,
    signal: 'co_author_trailer',
    tool: 'claude',
    confidence: 1,
    evidence: 'Co-authored-by: Claude Opus 5.5 (1M context) <noreply@anthropic.com>',
  },
  {
    repoId: REPO_ID,
    commitSha: SHA.agent,
    signal: 'author_identity',
    tool: 'copilot',
    confidence: 1,
    evidence: 'copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>',
  },
];

export const lineSpanFixture: LineSpan = { path: 'src/billing/invoice.ts', startLine: 12, lineCount: 8 };

/**
 * The worked example from the Metric definitions section of docs/architecture.md: 10 AI lines,
 * observed at OBSERVED_AT. Whole-day lifetimes are 10 (2 lines, removed), 45 (3, alive),
 * 60 (1, removed) and 200 (4, alive), so S(30) = 0.8, S(90) = S(180) = 0.64 and S(365) is unknown.
 */
export const survivalObservationFixtures: SurvivalObservation[] = [
  {
    repoId: REPO_ID,
    introducedBy: SHA.aiOld,
    removedBy: SHA.removerOne,
    lineCount: 2,
    introducedAt: AI_OLD_LANDED,
    removedAt: REMOVER_ONE_LANDED,
  },
  {
    repoId: REPO_ID,
    introducedBy: SHA.aiRecent,
    removedBy: null,
    lineCount: 3,
    introducedAt: AI_RECENT_LANDED,
    removedAt: null,
  },
  {
    repoId: REPO_ID,
    introducedBy: SHA.aiOld,
    removedBy: SHA.removerTwo,
    lineCount: 1,
    introducedAt: AI_OLD_LANDED,
    removedAt: REMOVER_TWO_LANDED,
  },
  {
    repoId: REPO_ID,
    introducedBy: SHA.aiOld,
    removedBy: null,
    lineCount: 4,
    introducedAt: AI_OLD_LANDED,
    removedAt: null,
  },
];

export const survivalMetricFixture: SurvivalMetric = {
  repoId: REPO_ID,
  cohort: 'ai',
  headSha: SHA.head,
  observedAt: OBSERVED_AT,
  linesTotal: 10,
  linesRemoved: 3,
  linesCensored: 7,
  survival30d: 0.8,
  survival90d: 0.64,
  survival180d: 0.64,
};

/** The same example as a step function. S drops the day after each removal day. */
export const survivalCurveFixture: SurvivalCurve = {
  cohort: 'ai',
  points: [
    { day: 0, survival: 1, atRisk: 10 },
    { day: 11, survival: 0.8, atRisk: 8 },
    { day: 46, survival: 0.8, atRisk: 5 },
    { day: 61, survival: 0.64, atRisk: 4 },
    { day: 200, survival: 0.64, atRisk: 4 },
  ],
};

/** A cohort too young for the later horizons: nothing has been observed for 90 days yet. */
export const youngSurvivalMetricFixture: SurvivalMetric = {
  repoId: REPO_ID,
  cohort: 'human',
  headSha: SHA.head,
  observedAt: OBSERVED_AT,
  linesTotal: 40,
  linesRemoved: 4,
  linesCensored: 36,
  survival30d: 0.9,
  survival90d: null,
  survival180d: null,
};

export const youngSurvivalCurveFixture: SurvivalCurve = {
  cohort: 'human',
  points: [
    { day: 0, survival: 1, atRisk: 40 },
    { day: 13, survival: 0.9, atRisk: 36 },
    { day: 60, survival: 0.9, atRisk: 10 },
  ],
};

/**
 * The second example from the doc, a reverted change: 10 AI lines, all removed 5 days after they
 * landed. Survival is 0 from day 6 on, which is a known result and not a missing one. It stands
 * alone: its commits are not in commitFixtures.
 */
export const revertedObservationFixtures: SurvivalObservation[] = [
  {
    repoId: REPO_ID,
    introducedBy: sha('1'),
    removedBy: sha('2'),
    lineCount: 10,
    introducedAt: daysBefore(OBSERVED_AT, 100),
    removedAt: daysBefore(OBSERVED_AT, 94.5),
  },
];

export const revertedSurvivalMetricFixture: SurvivalMetric = {
  repoId: REPO_ID,
  cohort: 'ai',
  headSha: SHA.head,
  observedAt: OBSERVED_AT,
  linesTotal: 10,
  linesRemoved: 10,
  linesCensored: 0,
  survival30d: 0,
  survival90d: 0,
  survival180d: 0,
};

export const revertedSurvivalCurveFixture: SurvivalCurve = {
  cohort: 'ai',
  points: [
    { day: 0, survival: 1, atRisk: 10 },
    { day: 6, survival: 0, atRisk: 0 },
  ],
};

export const pushEventFixture: RepoEventMessage = {
  version: 1,
  type: 'push',
  deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  receivedAt: '2026-10-01T09:30:00.123Z',
  installationId: INSTALLATION_ID,
  repo: { id: REPO_ID, owner: 'octo-org', name: 'hello.world' },
  headSha: SHA.head,
};

export const repositoryAddedEventFixture: RepoEventMessage = {
  version: 1,
  type: 'repository_added',
  deliveryId: '0b989ba4-242f-11e5-81e1-c7b6966d2516',
  receivedAt: '2026-10-01T09:31:00.000Z',
  installationId: INSTALLATION_ID,
  repo: { id: REPO_ID, owner: 'octo-org', name: 'hello.world' },
};

/** The repo went private: its data must go. */
export const repositoryRemovedEventFixture: RepoEventMessage = {
  version: 1,
  type: 'repository_removed',
  deliveryId: 'e4c1b7a0-2f5d-11ef-9a3c-8d2e6f1b4c70',
  receivedAt: '2026-10-01T09:32:00.000Z',
  installationId: INSTALLATION_ID,
  repo: { id: REPO_ID, owner: 'octo-org', name: 'hello.world' },
  reason: 'privatized',
};

// Each job carries the delivery of the event that caused it: pushEventFixture, then
// repositoryAddedEventFixture, then repositoryRemovedEventFixture.
export const analysisJobFixture: AnalysisJobMessage = {
  version: 1,
  type: 'analyze',
  jobId: '3f2b8c1e-7a4d-4e9b-9c0a-5d6e7f8a9b0c',
  requestedAt: '2026-10-01T09:30:01.000Z',
  deliveryId: pushEventFixture.deliveryId,
  reason: 'push',
  installationId: INSTALLATION_ID,
  repo: { id: REPO_ID, owner: 'octo-org', name: 'hello.world' },
  headSha: SHA.head,
};

/** A backfill has no head yet: the worker analyzes whatever the default branch points at. */
export const backfillJobFixture: AnalysisJobMessage = {
  ...analysisJobFixture,
  jobId: '9a1c7e52-0b3f-4d68-8e2a-1f4b6c8d0e2f',
  deliveryId: repositoryAddedEventFixture.deliveryId,
  reason: 'backfill',
  headSha: null,
};

export const deleteRepoJobFixture: DeleteRepoJobMessage = {
  version: 1,
  type: 'delete_repo',
  jobId: 'c7d2e9a4-1b6f-4c38-a5e0-6f9b3d1a7e24',
  requestedAt: '2026-10-01T09:32:01.000Z',
  deliveryId: repositoryRemovedEventFixture.deliveryId,
  repo: { id: REPO_ID, owner: 'octo-org', name: 'hello.world' },
  reason: 'privatized',
};

const { installationId: _installationId, ...apiRepo } = repoFixture;
export const apiRepoFixture: ApiRepo = apiRepo;

const { installationId: _newInstallationId, ...newApiRepo } = newRepoFixture;
export const newApiRepoFixture: ApiRepo = newApiRepo;

export const listReposResponseFixture: ListReposResponse = {
  repos: [apiRepoFixture, newApiRepoFixture],
};

export const repoSummaryResponseFixture: RepoSummaryResponse = {
  repo: apiRepoFixture,
  metrics: [survivalMetricFixture, youngSurvivalMetricFixture],
};

export const survivalCurveResponseFixture: SurvivalCurveResponse = {
  repoId: REPO_ID,
  headSha: SHA.head,
  headCommittedAt: HEAD_COMMITTED_AT,
  observedAt: OBSERVED_AT,
  curves: [survivalCurveFixture],
};
