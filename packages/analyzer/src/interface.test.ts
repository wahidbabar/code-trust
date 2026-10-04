// Pins the exported interface to the one in docs/tasks/T05-analyzer-attribution-survival.md, which
// the worker lane is written against. The expected types are copied here, not imported, so the
// comparison is not of a module with itself. tsc enforces it in the package typecheck.
import type {
  Attribution,
  Cohort,
  Commit,
  IsoTimestamp,
  SurvivalCurvePoint,
  SurvivalMetric,
  SurvivalObservation,
} from '@code-trust/shared';
import { expectTypeOf, test } from 'vitest';
import type { HistoryCommit } from './history/types.ts';
import {
  type AnalyzeOptions,
  analyzeRepo,
  attributeCommit,
  type CommitAttribution,
  estimateSurvival,
  type RepoAnalysis,
  type SurvivalEstimate,
} from './index.ts';

interface ExpectedCommitAttribution {
  cohort: Cohort;
  attributions: Pick<Attribution, 'signal' | 'tool' | 'confidence' | 'evidence'>[];
}

type ExpectedSurvivalEstimate = Pick<
  SurvivalMetric,
  'linesTotal' | 'linesRemoved' | 'linesCensored' | 'survival30d' | 'survival90d' | 'survival180d'
> & { points: SurvivalCurvePoint[] };

interface ExpectedAnalyzeOptions {
  repoDir: string;
  repoId: number;
  head?: string;
  observedAt: IsoTimestamp;
}

interface ExpectedRepoAnalysis {
  head: { headSha: string; headCommittedAt: IsoTimestamp; observedAt: IsoTimestamp };
  commits: Commit[];
  attributions: Attribution[];
  observations: SurvivalObservation[];
  rollups: { metric: SurvivalMetric; points: SurvivalCurvePoint[] }[];
}

test('attributeCommit, estimateSurvival and analyzeRepo match the interface the worker is written against', () => {
  expectTypeOf<CommitAttribution>().toEqualTypeOf<ExpectedCommitAttribution>();
  expectTypeOf<SurvivalEstimate>().toEqualTypeOf<ExpectedSurvivalEstimate>();
  expectTypeOf<AnalyzeOptions>().toEqualTypeOf<ExpectedAnalyzeOptions>();
  expectTypeOf<RepoAnalysis>().toEqualTypeOf<ExpectedRepoAnalysis>();
  expectTypeOf(attributeCommit).toEqualTypeOf<
    (commit: Pick<HistoryCommit, 'author' | 'committer' | 'message'>) => ExpectedCommitAttribution
  >();
  expectTypeOf(estimateSurvival).toEqualTypeOf<
    (
      observations: readonly Pick<SurvivalObservation, 'lineCount' | 'introducedAt' | 'removedAt'>[],
      observedAt: IsoTimestamp,
    ) => ExpectedSurvivalEstimate | null
  >();
  expectTypeOf(analyzeRepo).toEqualTypeOf<(options: ExpectedAnalyzeOptions) => Promise<ExpectedRepoAnalysis>>();
});
